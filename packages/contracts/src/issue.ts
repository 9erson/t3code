import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;
export const IssueListState = Schema.Literals(["open", "all", "closed"]);
export type IssueListState = typeof IssueListState.Type;
export const IssueActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export const IssueLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export const IssueListEntry = Schema.Struct({
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  state: IssueState,
  labels: Schema.Array(IssueLabel),
  assignees: Schema.Array(IssueActor),
  commentCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  observedAt: Schema.optional(Schema.Finite),
});
export type IssueListEntry = typeof IssueListEntry.Type;
export const IssueListCursors = Schema.Record(
  TrimmedNonEmptyString,
  TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
);
export const IssueListInput = Schema.Struct({
  state: IssueListState,
  projectId: Schema.optional(ProjectId),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  host: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  cursors: Schema.optional(IssueListCursors),
});
export type IssueListInput = typeof IssueListInput.Type;
export const IssueProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  projectCount: PositiveInt,
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export const IssueListResult = Schema.Struct({
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(IssueProviderSummary),
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      projectTitle: TrimmedNonEmptyString,
      message: TrimmedNonEmptyString,
    }),
  ),
  truncated: Schema.Boolean,
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;
export const IssueFailureReason = Schema.Literals([
  "credentials-missing",
  "auth-disabled",
  "authentication",
  "rate-limited",
  "provider-unsupported",
  "transient",
  "invalid-response",
]);
export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    host: Schema.String,
    reason: IssueFailureReason,
    retryAt: Schema.optionalKey(Schema.Finite),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "credentials-missing":
        return `No GitHub credentials for ${this.host}. Set GH_TOKEN or GITHUB_TOKEN, or install the GitHub CLI and run \`gh auth login --hostname ${this.host}\`.`;
      case "auth-disabled":
        return `GitHub host ${this.host} is turned off. Enable it in Settings → Source Control.`;
      case "authentication":
        return `GitHub refused the credential for ${this.host}. Update the saved token or run \`gh auth login --hostname ${this.host}\` and retry.`;
      case "rate-limited":
        return `GitHub rate limit reached for ${this.host}. Wait until the limit resets and refresh.`;
      case "provider-unsupported":
        return "This host cannot be browsed here yet.";
      case "invalid-response":
        return `GitHub returned an unreadable issues response for ${this.host}. Refresh to retry.`;
      case "transient":
        return `Could not read issues from ${this.host || "this environment"}. Check the connection and refresh to retry.`;
    }
  }
}
