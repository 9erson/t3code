import {
  CommandId,
  normalizeThreadIssueKey,
  type ThreadId,
  type ThreadIssueLink,
  type ThreadIssueSnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as IssueService from "../issue/IssueService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** Refreshes only linked issues on active threads, including closed issues that can reopen. */
export class IssueSyncReactor extends Context.Service<
  IssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IssueSyncReactor") {}

/** @public Service construction supports persisted tests with external issue providers. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const issues = yield* IssueService.IssueService;
  const crypto = yield* Crypto.Crypto;
  const sweep = Effect.fn("IssueSyncReactor.sweep")(function* () {
    const threads = yield* projections.getThreadsWithIssues();
    const groups = new Map<
      string,
      Array<{ readonly threadId: ThreadId; readonly link: ThreadIssueLink }>
    >();
    for (const thread of threads) {
      for (const link of thread.issues ?? []) {
        const key = normalizeThreadIssueKey(link);
        const identity = `${key.host}\0${key.repository}\0${key.number}`;
        const entries = groups.get(identity) ?? [];
        entries.push({ threadId: thread.id, link });
        groups.set(identity, entries);
      }
    }
    yield* Effect.forEach(
      groups.values(),
      (entries) =>
        Effect.gen(function* () {
          const key = normalizeThreadIssueKey(entries[0]!.link);
          const summary = yield* issues.summary(key, { fresh: true });
          const snapshot: ThreadIssueSnapshot = {
            title: summary.title,
            state: summary.state,
            updatedAt: summary.updatedAt,
          };
          for (const { threadId, link } of entries) {
            if (
              link.snapshot.title === snapshot.title &&
              link.snapshot.state === snapshot.state &&
              link.snapshot.updatedAt === snapshot.updatedAt
            )
              continue;
            // Sync updates an existing link only. An unlink committed during the host read wins.
            yield* engine.dispatch({
              type: "thread.issue.sync",
              commandId: CommandId.make(`server:issue-sync:${yield* crypto.randomUUIDv4}`),
              threadId,
              ...key,
              snapshot,
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("issue sync skipped", {
                  host: entries[0]!.link.host,
                  number: entries[0]!.link.number,
                }),
          ),
        ),
      // Issue summaries use REST reads, so keep host concurrency below the PR batch width.
      { concurrency: 5, discard: true },
    );
  });
  const worker = yield* makeDrainableWorker(sweep);
  const initialEnqueued = yield* Deferred.make<void>();
  let started = false;
  yield* Effect.addFinalizer(() => Deferred.succeed(initialEnqueued, undefined));
  const start: IssueSyncReactor["Service"]["start"] = Effect.fn("IssueSyncReactor.start")(
    function* () {
      if (started) return;
      started = true;
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* Deferred.succeed(initialEnqueued, undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );
  const drain = Effect.suspend(() =>
    started ? Deferred.await(initialEnqueued).pipe(Effect.andThen(worker.drain)) : worker.drain,
  );
  return IssueSyncReactor.of({ start, drain });
});
export const layer = Layer.effect(IssueSyncReactor, make);
