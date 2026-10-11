import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  IssueOperationError,
  WS_METHODS,
  type IssueDetail,
  type IssueListEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
  type NetworkStatus,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createIssueEnvironmentAtoms } from "./issues.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: () =>
      Atom.make(
        AsyncResult.success({
          authenticated: true,
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        }),
      ),
  }),
}));
const environmentId = EnvironmentId.make("environment");
const input = {
  projectId: ProjectId.make("project"),
  host: "github.com",
  repository: "acme/web",
  number: 2,
};
const detail: IssueDetail = {
  ...input,
  provider: "github",
  projectTitle: "Web",
  workspaceRoot: "/repo",
  title: "A bug",
  url: "https://github.com/acme/web/issues/2",
  author: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  state: "open",
  body: "Description",
  comments: [],
  commentsTruncated: false,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
};

const setup = (client: WsRpcProtocolClient) =>
  Effect.gen(function* () {
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    });
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
      }),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some({
          client,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.never,
        }),
      ),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const runtime = Atom.runtime(
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([[environmentId, { target, profile: Option.none(), enabled: true }]]),
        ),
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      }),
    );
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    const atoms = createIssueEnvironmentAtoms(runtime);
    return { registry, atoms };
  });

const writeCases = (["setState", "setLabels", "comment"] as const).flatMap((method) =>
  [true, false].map((succeeds) => ({ method, succeeds })),
);
const comment = {
  id: 42,
  url: `${detail.url}#issuecomment-42`,
  author: null,
  body: "Confirmed",
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
};
const expectedWrite = (value: IssueListEntry, method: "setState" | "setLabels" | "comment") =>
  method === "setState"
    ? value.state
    : method === "setLabels"
      ? value.labels.map((label) => label.name)
      : value.commentCount;
it.effect.each(writeCases)(
  "optimistically updates row and panel for $method, then settles or visibly rolls back (success: $succeeds)",
  ({ method, succeeds }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        yield* Effect.addFinalizer(() => Effect.sync(release));
        let current = detail;
        const respond = <A>(update: () => A) =>
          Effect.promise(async () => {
            started();
            await gate;
          }).pipe(
            Effect.andThen(() =>
              succeeds
                ? Effect.sync(update)
                : Effect.fail(
                    new IssueOperationError({ host: "github.com", reason: "authentication" }),
                  ),
            ),
          );
        const client = {
          [WS_METHODS.issuesDetail]: () => Effect.sync(() => current),
          [WS_METHODS.issuesList]: () =>
            Effect.sync(() => ({
              viewers: {},
              providers: [],
              errors: [],
              nextCursors: {},
              truncated: false,
              entries: [current],
            })),
          [WS_METHODS.issuesSubscribeRefreshes]: () => Stream.never,
          [WS_METHODS.issuesSetState]: () =>
            respond(() => {
              current = { ...current, state: "closed" };
              return "closed" as const;
            }),
          [WS_METHODS.issuesSetLabels]: () =>
            respond(() => {
              current = { ...current, labels: [{ name: "bug", color: "ff0000" }] };
              return current.labels;
            }),
          [WS_METHODS.issuesComment]: () =>
            respond(() => {
              current = { ...current, comments: [comment], commentCount: 1 };
              return comment;
            }),
        } as unknown as WsRpcProtocolClient;
        const { registry, atoms } = yield* setup(client);
        const panel = atoms.detail({ environmentId, input });
        const rows = atoms.list({ environmentId, input: { state: "all" } });
        yield* AtomRegistry.mount(registry, panel);
        yield* AtomRegistry.mount(registry, rows);
        yield* AtomRegistry.getResult(registry, panel);
        yield* AtomRegistry.getResult(registry, rows);
        const write = atoms[method].run(registry, {
          environmentId,
          input: { ...input, state: "closed", labels: ["bug"], body: "Confirmed" },
        });
        yield* Effect.promise(() => entered);
        const optimistic = method === "setState" ? "closed" : method === "setLabels" ? ["bug"] : 1;
        expect(expectedWrite(yield* AtomRegistry.getResult(registry, panel), method)).toEqual(
          optimistic,
        );
        expect(
          expectedWrite((yield* AtomRegistry.getResult(registry, rows)).entries[0]!, method),
        ).toEqual(optimistic);
        expect(registry.get(rows).waiting).toBe(true);
        release();
        const result = yield* Effect.promise(() => write);
        expect(result._tag).toBe(succeeds ? "Success" : "Failure");
        const settled = yield* AtomRegistry.getResult(registry, panel);
        expect(expectedWrite(settled, method)).toEqual(
          succeeds ? optimistic : expectedWrite(detail, method),
        );
        expect(
          expectedWrite((yield* AtomRegistry.getResult(registry, rows)).entries[0]!, method),
        ).toEqual(succeeds ? optimistic : expectedWrite(detail, method));
        expect(settled.comments.filter((entry) => entry.id === 42)).toHaveLength(
          succeeds && method === "comment" ? 1 : 0,
        );
        expect(registry.get(atoms.writeStatus({ environmentId, input })).pending).toBe(false);
        expect(registry.get(atoms.writeStatus({ environmentId, input })).error).toBe(
          succeeds
            ? null
            : "GitHub refused the credential for github.com. Update the saved token or run `gh auth login --hostname github.com` and retry.",
        );
      }),
    ),
);
