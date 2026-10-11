import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EventStore from "./EventStore.ts";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
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
const makeTestLayer = <E extends Layer.Error<ReturnType<typeof SqlitePersistence.layerFromPath>>>(
  layerDatabase: Layer.Layer<SqlClient.SqlClient, E>,
) =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EventStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "control-reads" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
const layerTest = makeTestLayer(layerDatabase);

it.effect("persists normalized issue links in thread shells and removes them on unlink", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const threadId = ThreadId.make("thread:issue-links");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-issue-thread"),
      threadId,
      projectId: ProjectId.make("project:issue-links"),
      title: "Issue work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.issue.link",
      commandId: CommandId.make("link-issue"),
      threadId,
      host: "GitHub.COM",
      repository: "Owner/Repo",
      number: 5,
      url: "https://github.com/owner/repo/issues/5",
      snapshot: { title: "Fix it", state: "open", updatedAt: "2026-10-01T00:00:00Z" },
    });
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const persisted = yield* events
      .read({ threadId, eventType: "thread.issues-updated" })
      .pipe(Stream.runCollect);
    assert.equal(persisted.length, 1);
    assert.deepStrictEqual(
      (yield* projections.getThreadShell(threadId))?.issues?.map(
        ({ host, repository, number, snapshot }) => ({ host, repository, number, snapshot }),
      ),
      [
        {
          host: "github.com",
          repository: "owner/repo",
          number: 5,
          snapshot: { title: "Fix it", state: "open", updatedAt: "2026-10-01T00:00:00Z" },
        },
      ],
    );
    yield* orchestrator.dispatch({
      type: "thread.issue.unlink",
      commandId: CommandId.make("unlink-issue"),
      threadId,
      host: "GITHUB.com",
      repository: "OWNER/REPO",
      number: 5,
    });
    const removed = yield* events
      .read({ threadId, eventType: "thread.issues-updated" })
      .pipe(Stream.runCollect);
    assert.equal(removed.length, 2);
    assert.deepStrictEqual((yield* projections.getThreadShell(threadId))?.issues, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps multiple issue links and their latest state across database reopen, including unlink",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-issue-links-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      );
      const runtime = makeTestLayer(database);
      const threadId = ThreadId.make("thread:reopened-issues");
      const key = { host: "github.com", repository: "owner/repo" };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-reopened-thread"),
            threadId,
            projectId: ProjectId.make("project:issue-links"),
            title: "Issue work",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          for (const number of [5, 6]) {
            yield* orchestrator.dispatch({
              type: "thread.issue.link",
              commandId: CommandId.make(`reopened-link:${number}`),
              threadId,
              ...key,
              number,
              url: `https://github.com/owner/repo/issues/${number}`,
              snapshot: {
                title: `Issue ${number}`,
                state: "open",
                updatedAt: "2026-10-01T00:00:00Z",
              },
            });
          }
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const events = yield* EventStore.EventStoreV2;
          assert.equal(
            (yield* events
              .read({ threadId, eventType: "thread.issues-updated" })
              .pipe(Stream.runCollect)).length,
            2,
          );
        }).pipe(Effect.provide(runtime)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          assert.deepStrictEqual(
            (yield* projections.getThreadShell(threadId))?.issues?.map(({ number, snapshot }) => ({
              number,
              state: snapshot.state,
            })),
            [
              { number: 5, state: "open" },
              { number: 6, state: "open" },
            ],
          );
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.issue.unlink",
            commandId: CommandId.make("reopened-unlink"),
            threadId,
            ...key,
            number: 5,
          });
          yield* orchestrator.dispatch({
            type: "thread.issue.sync",
            commandId: CommandId.make("reopened-sync"),
            threadId,
            ...key,
            number: 6,
            snapshot: {
              title: "Resolved issue",
              state: "closed",
              updatedAt: "2026-10-02T00:00:00Z",
            },
          });
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          const events = yield* EventStore.EventStoreV2;
          assert.equal(
            (yield* events
              .read({ threadId, eventType: "thread.issues-updated" })
              .pipe(Stream.runCollect)).length,
            4,
          );
        }).pipe(Effect.provide(runtime)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          assert.deepStrictEqual(
            (yield* projections.getThreadShell(threadId))?.issues?.map(({ number, snapshot }) => ({
              number,
              snapshot,
            })),
            [
              {
                number: 6,
                snapshot: {
                  title: "Resolved issue",
                  state: "closed",
                  updatedAt: "2026-10-02T00:00:00Z",
                },
              },
            ],
          );
        }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(database)))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
