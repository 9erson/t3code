import {
  CommandId,
  IssueLinkInput,
  IssueOperationError,
  IssueLinkedThreadsResult,
  ThreadIssueKey,
  normalizeThreadIssueKey,
  type IssueListEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Crypto from "effect/Crypto";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as IssueService from "./IssueService.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(IssueLinkedThreadsResult);
export class ThreadIssueService extends Context.Service<
  ThreadIssueService,
  {
    readonly link: (input: IssueLinkInput) => Effect.Effect<void, IssueOperationError>;
    readonly unlink: (input: IssueLinkInput) => Effect.Effect<void, IssueOperationError>;
    readonly summary: (input: ThreadIssueKey) => Effect.Effect<IssueListEntry, IssueOperationError>;
    readonly linkedThreads: (
      input: ThreadIssueKey,
    ) => Effect.Effect<IssueLinkedThreadsResult, IssueOperationError>;
  }
>()("t3/issue/ThreadIssueService") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const issues = yield* IssueService.IssueService;
  const summary = issues.summary;
  const dispatch = Effect.fn("ThreadIssueService.dispatch")(
    function* (input: IssueLinkInput, issue?: IssueListEntry) {
      const key = normalizeThreadIssueKey(input);
      const commandId = CommandId.make(`issue-link:${yield* crypto.randomUUIDv4}`);
      yield* orchestrator.dispatch(
        issue === undefined
          ? { type: "thread.issue.unlink", commandId, threadId: input.threadId, ...key }
          : {
              type: "thread.issue.link",
              commandId,
              threadId: input.threadId,
              ...key,
              url: issue.url,
              snapshot: { title: issue.title, state: issue.state, updatedAt: issue.updatedAt },
            },
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new IssueOperationError({ host: input.host, reason: "transient", cause }),
        ),
      ),
  );
  return ThreadIssueService.of({
    summary,
    link: Effect.fn("ThreadIssueService.link")(function* (input) {
      const issue = yield* summary(input);
      yield* dispatch(input, issue);
    }),
    unlink: (input) => dispatch(input),
    linkedThreads: Effect.fn("ThreadIssueService.linkedThreads")(
      function* (input) {
        const key = normalizeThreadIssueKey(input);
        const rows =
          yield* sql`SELECT t.thread_id AS id, t.project_id AS "projectId", t.title, t.archived_at AS "archivedAt"
        FROM orchestration_v2_projection_thread_issues i JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
        WHERE i.host = ${key.host} AND i.repository = ${key.repository} AND i.number = ${key.number} AND t.deleted_at IS NULL
        ORDER BY t.updated_at DESC, t.thread_id ASC`;
        return yield* decodeLinkedThreads({ threads: rows });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) => new IssueOperationError({ host: input.host, reason: "transient", cause }),
          ),
        ),
    ),
  });
});
