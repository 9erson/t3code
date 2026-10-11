import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { IssueState } from "./issue.ts";

export const ThreadIssueKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;
export const ThreadIssueSnapshot = Schema.Struct({
  title: TrimmedNonEmptyString,
  state: IssueState,
  updatedAt: IsoDateTime,
});
export type ThreadIssueSnapshot = typeof ThreadIssueSnapshot.Type;
export const ThreadIssueLink = Schema.Struct({
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
  snapshot: ThreadIssueSnapshot,
});
export type ThreadIssueLink = typeof ThreadIssueLink.Type;
export const IssueLinkInput = Schema.Struct({ threadId: ThreadId, ...ThreadIssueKey.fields });
export type IssueLinkInput = typeof IssueLinkInput.Type;

/** GitHub host and repository identities are case-insensitive. */
export function normalizeThreadIssueKey(key: ThreadIssueKey): ThreadIssueKey {
  return {
    host: key.host.trim().toLowerCase(),
    repository: key.repository.trim().toLowerCase(),
    number: key.number,
  };
}
export function threadIssueKeysEqual(left: ThreadIssueKey, right: ThreadIssueKey): boolean {
  const a = normalizeThreadIssueKey(left);
  const b = normalizeThreadIssueKey(right);
  return a.host === b.host && a.repository === b.repository && a.number === b.number;
}

export const IssueLinkedThreadsResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      archivedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export type IssueLinkedThreadsResult = typeof IssueLinkedThreadsResult.Type;
