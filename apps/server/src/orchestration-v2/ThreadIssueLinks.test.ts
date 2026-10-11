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
import * as EventStore from "./EventStore.ts";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

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
