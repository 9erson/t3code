import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, IssueOperationError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type {
  NetworkStatus,
  PreparedConnection,
  SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createIssueEnvironmentAtoms, mergeIssueListPages, issueListNextPage } from "./issues.ts";

it.effect("revalidates mounted issues on a server push and after manual invalidation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let title = "Original";
      let state: "open" | "closed" = "open";
      const client = {
        [WS_METHODS.issuesList]: (input: { cursors?: Record<string, string>; host?: string }) =>
          input.host === "broken"
            ? Effect.fail(
                new IssueOperationError({ host: "broken", reason: "credentials-missing" }),
              )
            : Effect.sync(() => ({
                viewers: {},
                providers: [],
                errors: [],
                nextCursors: {},
                truncated: false,
                entries: [
                  {
                    title,
                    number: input.cursors ? 2 : 1,
                    provider: "github",
                    host: "github.com",
                    repository: "acme/web",
                    projectId: ProjectId.make("p"),
                    projectTitle: "Web",
                    url: "https://github.com/acme/web/issues/1",
                    author: null,
                    state: "open",
                    labels: [],
                    assignees: [],
                    commentCount: 0,
                    createdAt: "2026-07-01T00:00:00Z",
                    updatedAt: "2026-07-01T00:00:00Z",
                  },
                ],
              })),
        [WS_METHODS.issuesDetail]: () =>
          Effect.sync(() => ({ title, body: `Body: ${title}`, comments: [] })),
        [WS_METHODS.issuesSummary]: () => Effect.sync(() => ({ title, state })),
        [WS_METHODS.issuesSubscribeRefreshes]: () => SubscriptionRef.changes(revision),
        [WS_METHODS.issuesInvalidate]: () => SubscriptionRef.update(revision, (value) => value + 1),
      } as unknown as WsRpcProtocolClient;
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment"),
        label: "Test",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      });
      const session: RpcSession = {
        client,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
      };
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
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([[target.environmentId, { target, profile: Option.none(), enabled: true }]]),
          ),
          run: (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          runStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        }),
      );
      const atoms = createIssueEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const list = atoms.list({ environmentId: target.environmentId, input: { state: "open" } });
      const detail = atoms.detail({
        environmentId: target.environmentId,
        input: {
          projectId: ProjectId.make("project"),
          host: "github.com",
          repository: "acme/web",
          number: 2,
        },
      });
      const unmountDetail = registry.mount(detail);
      yield* Effect.addFinalizer(() => Effect.sync(unmountDetail));
      expect((yield* AtomRegistry.getResult(registry, detail)).body).toBe("Body: Original");
      const summary = atoms.summary({
        environmentId: target.environmentId,
        input: { host: "github.com", repository: "acme/web", number: 2 },
      });
      const unmountSummary = registry.mount(summary);
      yield* Effect.addFinalizer(() => Effect.sync(unmountSummary));
      expect((yield* AtomRegistry.getResult(registry, summary)).state).toBe("open");
      const unmount = registry.mount(list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect((yield* AtomRegistry.getResult(registry, list)).entries[0]?.title).toBe("Original");
      const continuation = {
        environmentId: target.environmentId,
        input: { state: "open" as const, cursors: { "github.com acme/web": "2:0" } },
      };
      const broken = {
        environmentId: EnvironmentId.make("broken"),
        input: { state: "open" as const, host: "broken" },
      };
      const pages = atoms.listPages(
        JSON.stringify([
          { environmentId: target.environmentId, input: { state: "open" } },
          continuation,
          broken,
        ]),
      );
      const stopPages = registry.mount(pages);
      yield* Effect.addFinalizer(() => Effect.sync(stopPages));
      yield* AtomRegistry.getResult(registry, atoms.list(continuation));
      yield* AtomRegistry.getResult(registry, atoms.list(broken)).pipe(Effect.result);
      const merged = registry.get(pages);
      expect(merged.values[0]?.[1].entries.map((entry) => entry.number)).toEqual([1, 2]);
      expect(merged.errors).toHaveLength(1);
      expect(merged.isPending).toBe(false);
      stopPages();
      for (const manual of [false, true]) {
        title = manual ? "Manual" : "Pushed";
        state = manual ? "open" : "closed";
        const expected = title;
        const changed = Latch.makeUnsafe();
        const stop = registry.subscribe(list, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.entries[0]?.title === expected)
            changed.openUnsafe();
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        if (manual)
          expect(
            AsyncResult.isSuccess(
              yield* Effect.promise(() =>
                atoms.invalidate.run(registry, { environmentId: target.environmentId, input: {} }),
              ),
            ),
          ).toBe(true);
        else yield* SubscriptionRef.update(revision, (value) => value + 1);
        yield* changed.await;
        expect((yield* AtomRegistry.getResult(registry, list)).entries[0]?.title).toBe(expected);
        expect((yield* AtomRegistry.getResult(registry, detail)).body).toBe(`Body: ${expected}`);
        expect((yield* AtomRegistry.getResult(registry, summary)).state).toBe(state);
        stop();
      }
    }),
  ),
);

it("appends issue pages without duplicates, keeps exhausted repository rows, and uses the newest observation", () => {
  const row = (number: number, title: string, observedAt: number) => ({
    provider: "github" as const,
    host: "github.com",
    repository: "acme/web",
    projectId: ProjectId.make("p"),
    projectTitle: "Web",
    number,
    title,
    url: `https://github.com/acme/web/issues/${number}`,
    author: null,
    state: "open" as const,
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    observedAt,
  });
  const first = {
    viewers: { "github.com": "alice" },
    providers: [],
    errors: [],
    truncated: true,
    nextCursors: { "github.com acme/web": "2:0" },
    entries: [row(1, "First", 1), row(2, "Before", 1)],
  };
  const second = {
    ...first,
    entries: [row(2, "After", 2), row(3, "Third", 2)],
    truncated: false,
    nextCursors: {},
  };
  const merged = mergeIssueListPages(first, second);
  expect(merged.entries.map((entry) => [entry.number, entry.title])).toEqual([
    [1, "First"],
    [2, "After"],
    [3, "Third"],
  ]);
  expect(merged.nextCursors).toEqual({});
  expect(merged.truncated).toBe(false);
});

it("continues only unfinished environments with bounded per-read limits and stops after ten pages", () => {
  const targets = ["first", "exhausted"].map((id) => ({
    environmentId: EnvironmentId.make(id),
    input: { state: "open" as const, limit: 100 },
  }));
  const result = {
    viewers: {},
    providers: [],
    errors: [],
    entries: [],
    truncated: true,
    nextCursors: { "github.com acme/web": "2:7" },
  };
  expect(
    issueListNextPage(
      targets,
      [
        [targets[0]!.environmentId, result],
        [targets[1]!.environmentId, { ...result, truncated: false, nextCursors: {} }],
      ],
      1,
    ),
  ).toEqual([
    {
      environmentId: "first",
      input: { state: "open", limit: 100, cursors: { "github.com acme/web": "2:7" } },
    },
  ]);
  expect(issueListNextPage(targets, [[targets[0]!.environmentId, result]], 10)).toEqual([]);
});
