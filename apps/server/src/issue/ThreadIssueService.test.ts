import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubIssueProvider from "@t3tools/source-control-github/server/GitHubIssueProvider";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueReadCache from "./IssueReadCache.ts";
import * as IssueProviderRegistry from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:issue-service");
const key = { host: "github.com", repository: "acme/web", number: 5 };
const input = (threadId: ThreadId) => ({ ...key, threadId });
const project = {
  id: projectId,
  title: "Web",
  workspaceRoot: "/web",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    provider: "github",
    displayName: "acme/web",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
  },
};
const transport = Layer.succeed(
  GitHubApi.GitHubApi,
  GitHubApi.GitHubApi.of({
    credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
    graphql: () => Effect.die("REST only"),
    rest: ({ path }) =>
      path.endsWith("/999")
        ? Effect.fail(
            new GitHubApi.GitHubApiRequestError({
              host: "github.com",
              operation: "read",
              cause: new Error("Unavailable"),
            }),
          )
        : Effect.succeed({
            status: 200,
            headers: {},
            truncated: false,
            invalidUtf8: false,
            body: JSON.stringify({
              number: 5,
              title: "Fix issue",
              html_url: "https://github.com/acme/web/issues/5",
              user: null,
              state: "closed",
              labels: [],
              assignees: [],
              comments: 0,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
            }),
          }),
  }),
);
const layerIssues = IssueService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        listShells: () => Effect.succeed([project]),
        getShell: () => Effect.succeed(Option.some(project)),
      }),
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.effect(IssueReadCache.IssueReadCache, IssueReadCache.make).pipe(
        Layer.provide(KeyValueStore.layerMemory),
        Layer.provide(NodeCrypto.layer),
      ),
      Layer.effect(
        IssueProviderRegistry.IssueProviderRegistry,
        GitHubIssueProvider.make.pipe(
          Effect.map((provider) => ({ get: (kind) => (kind === "github" ? provider : null) })),
        ),
      ).pipe(Layer.provide(transport)),
    ),
  ),
);
const layerTest = Layer.mergeAll(
  layerCore,
  layerIssues,
  NodeCrypto.layer,
  ProjectionMaintenance.layer.pipe(Layer.provide(layerCore)),
);
const createThread = Effect.fn(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:issue-service:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

it.effect(
  "links a verified closed issue once, lists every linked thread and survives projection rebuild",
  () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.make;
      const first = yield* createThread("first");
      const second = yield* createThread("second");
      yield* service.link({ ...input(first), host: "GitHub.COM", repository: "Acme/Web" });
      yield* service.link(input(first));
      yield* service.link(input(second));
      const events = yield* EventStore.EventStoreV2;
      const persisted = yield* events
        .read({ threadId: first, eventType: "thread.issues-updated" })
        .pipe(Stream.runCollect);
      assert.equal(persisted.length, 1);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const linked = (yield* store.getThreadShell(first))?.issues ?? [];
      assert.equal(linked.length, 1);
      assert.equal(linked[0]?.snapshot.state, "closed");
      assert.deepStrictEqual(
        (yield* service.linkedThreads({ ...key, repository: "ACME/WEB" })).threads
          .map((thread) => thread.id)
          .toSorted(),
        [first, second].toSorted(),
      );
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      assert.deepStrictEqual((yield* store.getThreadShell(first))?.issues, linked);
      assert.equal((yield* service.linkedThreads(key)).threads.length, 2);
      yield* service.unlink(input(first));
      yield* service.unlink(input(first));
      assert.deepStrictEqual((yield* store.getThreadShell(first))?.issues, []);
      assert.deepStrictEqual(
        (yield* service.linkedThreads(key)).threads.map((thread) => thread.id),
        [second],
      );
      yield* maintenance.rebuild;
      assert.deepStrictEqual((yield* store.getThreadShell(first))?.issues, []);
      assert.deepStrictEqual(
        (yield* service.linkedThreads(key)).threads.map((thread) => thread.id),
        [second],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("failed GitHub reads and unavailable repositories never create a link", () =>
  Effect.gen(function* () {
    const service = yield* ThreadIssueService.make;
    const threadId = yield* createThread("failed");
    for (const key of [
      { ...input(threadId), number: 999 },
      { ...input(threadId), repository: "acme/missing" },
    ]) {
      assert.equal((yield* service.link(key).pipe(Effect.exit))._tag, "Failure");
    }
    const events = yield* EventStore.EventStoreV2;
    assert.deepStrictEqual(
      yield* events.read({ threadId, eventType: "thread.issues-updated" }).pipe(Stream.runCollect),
      [],
    );
    const store = yield* ProjectionStore.ProjectionStoreV2;
    assert.deepStrictEqual((yield* store.getThreadShell(threadId))?.issues, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unlinks saved issues even when GitHub can no longer read them", () =>
  Effect.gen(function* () {
    const threadId = yield* createThread("offline");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("offline-link"),
      threadId,
      ...key,
      number: 999,
      url: "https://github.com/acme/web/issues/999",
      snapshot: { title: "Unavailable issue", state: "open", updatedAt: "2026-10-01T00:00:00Z" },
    });
    const service = yield* ThreadIssueService.make;
    assert.equal(
      (yield* service.summary({ ...key, number: 999 }).pipe(Effect.exit))._tag,
      "Failure",
    );
    yield* service.unlink({ ...input(threadId), number: 999 });
    const events = yield* EventStore.EventStoreV2;
    const persisted = yield* events
      .read({ threadId, eventType: "thread.issues-updated" })
      .pipe(Stream.runCollect);
    assert.equal(persisted.length, 2);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    assert.deepStrictEqual((yield* store.getThreadShell(threadId))?.issues, []);
    assert.deepStrictEqual((yield* service.linkedThreads({ ...key, number: 999 })).threads, []);
  }).pipe(Effect.provide(layerTest)),
);
