import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadIssueSnapshot,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import type {
  IssueProviderApi,
  ProviderIssue,
} from "@t3tools/source-control-core/server/IssueProvider";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestClock from "effect/testing/TestClock";
import { ServerActivation } from "../serverActivation.ts";
import * as Deferred from "effect/Deferred";
import { IssueOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as IssueProviderRegistry from "../issue/IssueProviderRegistry.ts";
import * as IssueReadCache from "../issue/IssueReadCache.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import * as IssueSyncReactor from "./IssueSyncReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Issue synchronization must not wake an agent"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const runtime = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EventStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "issue-sync" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const key = { host: "github.com", repository: "owner/repo", number: 7 };
const initial: ThreadIssueSnapshot = {
  title: "Fix issue",
  state: "open",
  updatedAt: "2026-10-01T00:00:00Z",
};
const project: OrchestrationProjectShell = {
  id: ProjectId.make("project:issues"),
  title: "Issues",
  workspaceRoot: "/issues",
  defaultModelSelection: null,
  scripts: [],
  createdAt: initial.updatedAt,
  updatedAt: initial.updatedAt,
  repositoryIdentity: {
    canonicalKey: "github.com/owner/repo",
    provider: "github",
    displayName: "owner/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/owner/repo.git",
    },
  },
};
const issue = (snapshot: ThreadIssueSnapshot, number = 7): ProviderIssue => ({
  ...snapshot,
  number,
  url: `https://github.com/owner/repo/issues/${number}`,
  author: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: initial.updatedAt,
});
const makeFixture = Effect.fnUntraced(function* (read: IssueProviderApi["getIssueSummary"]) {
  const reads = yield* Queue.unbounded<number>();
  const calls = yield* Ref.make<ReadonlyArray<number>>([]);
  const provider: IssueProviderApi = {
    kind: "github",
    getIssueSummary: (input) =>
      Ref.update(calls, (calls) => [...calls, input.number]).pipe(
        Effect.andThen(Queue.offer(reads, input.number)),
        Effect.andThen(read(input)),
      ),
    listIssues: () => Effect.die("Background synchronization must not list issues"),
    getIssue: () => Effect.die("Background synchronization only reads summaries"),
    getViewer: () => Effect.die("Background synchronization does not need viewer identity"),
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([project]) }),
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
    Layer.succeed(IssueProviderRegistry.IssueProviderRegistry, { get: () => provider }),
    Layer.effect(IssueReadCache.IssueReadCache, IssueReadCache.make).pipe(
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(NodeServices.layer),
    ),
  );
  const service = yield* IssueService.make.pipe(Effect.provide(dependencies));
  const reactor = yield* IssueSyncReactor.make.pipe(
    Effect.provideService(IssueService.IssueService, service),
  );
  return { reactor, service, reads, calls };
});
const createThread = Effect.fnUntraced(function* (id: string, linked = true, number = 7) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: project.id,
    title: "Issue work",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  if (linked)
    yield* engine.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make(`link:${id}`),
      threadId,
      ...key,
      number,
      url: issue(initial, number).url,
      snapshot: initial,
    });
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  return threadId;
});
const states = Effect.fnUntraced(function* (threadId: ThreadId) {
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  const events = yield* (yield* EventStore.EventStoreV2)
    .read({ threadId, eventType: "thread.issues-updated" })
    .pipe(Stream.runCollect);
  return events.map(({ event }) =>
    event.type === "thread.issues-updated"
      ? (event.payload.issues ?? []).map((link) => link.snapshot.state)
      : [],
  );
});

it.effect("refreshes linked thread chips from persisted issue events without waking agents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closed = { ...initial, state: "closed" as const, updatedAt: "2026-10-02T00:00:00Z" };
      const fixture = yield* makeFixture(() => Effect.succeed(issue(closed)));
      const threadId = yield* createThread("linked");
      yield* createThread("unlinked", false);
      yield* fixture.reactor.start();
      yield* Queue.take(fixture.reads);
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* states(threadId), [["open"], ["closed"]]);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.deepStrictEqual(
        (yield* projections.getThreadShell(threadId))?.issues?.map((link) => link.snapshot),
        [closed],
      );
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [7]);
      assert.deepStrictEqual((yield* projections.getThreadProjection(threadId))?.runs, []);
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("observes externally reopened issues and reads a shared link once per cycle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* Ref.make<ThreadIssueSnapshot>({ ...initial, state: "closed" });
      const fixture = yield* makeFixture(() => Ref.get(current).pipe(Effect.map(issue)));
      const first = yield* createThread("first");
      const second = yield* createThread("second");
      yield* fixture.reactor.start();
      yield* Queue.take(fixture.reads);
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [7]);
      yield* Ref.set(current, initial);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(fixture.reads);
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* states(first), [["open"], ["closed"], ["open"]]);
      assert.deepStrictEqual(yield* states(second), [["open"], ["closed"], ["open"]]);
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [7, 7]);
      // Re-reading an unchanged issue produces no new projected events.
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(fixture.reads);
      yield* fixture.reactor.drain;
      assert.equal((yield* states(first)).length, 3);
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("continues refreshing other linked issues when one host read fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture(({ number }) =>
        number === 7
          ? Effect.fail(new IssueOperationError({ host: key.host, reason: "transient" }))
          : Effect.succeed(issue({ ...initial, state: "closed" }, number)),
      );
      const threadId = yield* createThread("failure");
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make("link:second"),
        threadId,
        ...key,
        number: 8,
        url: issue(initial, 8).url,
        snapshot: initial,
      });
      yield* fixture.reactor.start();
      yield* Queue.take(fixture.reads);
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* states(threadId), [
        ["open"],
        ["open", "open"],
        ["open", "closed"],
      ]);
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("refreshes from the host even when a recent client summary is cached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* Ref.make<ThreadIssueSnapshot>(initial);
      const fixture = yield* makeFixture(() => Ref.get(current).pipe(Effect.map(issue)));
      const threadId = yield* createThread("cached");
      yield* fixture.service.summary(key);
      yield* Queue.take(fixture.reads);
      yield* Ref.set(current, { ...initial, state: "closed" });
      yield* fixture.reactor.start();
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* states(threadId), [["open"], ["closed"]]);
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("does not resurrect a link removed while its host read is in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const fixture = yield* makeFixture(() =>
        Deferred.await(release).pipe(Effect.as(issue({ ...initial, state: "closed" }))),
      );
      const threadId = yield* createThread("unlink-race");
      yield* fixture.reactor.start();
      yield* Queue.take(fixture.reads);
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.issue.unlink",
        commandId: CommandId.make("unlink:in-flight"),
        threadId,
        ...key,
      });
      yield* Deferred.succeed(release, undefined);
      yield* fixture.reactor.drain;
      assert.deepStrictEqual(yield* states(threadId), [["open"], []]);
      assert.deepStrictEqual(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId))?.issues,
        [],
      );
      assert.deepStrictEqual(
        yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadsWithIssues(),
        [],
      );
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("parks startup until activation and drains its initial sweep exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const fixture = yield* makeFixture(() =>
          Effect.succeed(issue({ ...initial, state: "closed" })),
        );
        const threadId = yield* createThread("activation");
        yield* fixture.reactor.start();
        yield* fixture.reactor.start();
        assert.deepStrictEqual(yield* Ref.get(fixture.calls), []);
        yield* Deferred.succeed(activation, undefined);
        yield* fixture.reactor.drain;
        assert.deepStrictEqual(yield* states(threadId), [["open"], ["closed"]]);
        assert.deepStrictEqual(yield* Ref.get(fixture.calls), [7]);
      }).pipe(Effect.provideService(ServerActivation, Deferred.await(activation)));
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);

it.effect("bounds concurrent host reads even when many linked issues are due", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const readers = yield* Ref.make({ active: 0, maximum: 0 });
      const fixture = yield* makeFixture(({ number }) =>
        Effect.gen(function* () {
          yield* Ref.update(readers, ({ active, maximum }) => ({
            active: active + 1,
            maximum: Math.max(maximum, active + 1),
          }));
          yield* Effect.yieldNow;
          yield* Ref.update(readers, ({ active, maximum }) => ({ active: active - 1, maximum }));
          return issue({ ...initial, state: "closed" }, number);
        }),
      );
      for (let number = 1; number <= 12; number += 1)
        yield* createThread(`bounded:${number}`, true, number);
      yield* fixture.reactor.start();
      yield* fixture.reactor.drain;
      const observed = yield* Ref.get(readers);
      assert.equal(observed.active, 0);
      assert.isAtMost(observed.maximum, 5);
      assert.equal((yield* Ref.get(fixture.calls)).length, 12);
      assert.deepStrictEqual(yield* states(ThreadId.make("bounded:12")), [["open"], ["closed"]]);
    }).pipe(Effect.provide(runtime), Effect.provide(NodeServices.layer)),
  ),
);
