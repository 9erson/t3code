import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, WS_METHODS } from "@t3tools/contracts";
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
import { createIssueEnvironmentAtoms } from "./issues.ts";

it.effect("revalidates mounted issues on a server push and after manual invalidation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const revision = yield* SubscriptionRef.make(0);
      let title = "Original";
      const client = {
        [WS_METHODS.issuesList]: () =>
          Effect.sync(() => ({
            viewers: {},
            providers: [],
            errors: [],
            nextCursors: {},
            truncated: false,
            entries: [{ title }],
          })),
        [WS_METHODS.issuesDetail]: () =>
          Effect.sync(() => ({ title, body: `Body: ${title}`, comments: [] })),
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
      const unmount = registry.mount(list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect((yield* AtomRegistry.getResult(registry, list)).entries[0]?.title).toBe("Original");
      for (const manual of [false, true]) {
        title = manual ? "Manual" : "Pushed";
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
        stop();
      }
    }),
  ),
);
