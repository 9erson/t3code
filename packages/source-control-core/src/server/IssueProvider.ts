import type {
  IssueDetail,
  IssueListEntry,
  IssueListState,
  IssueListSort,
  IssueListFilters,
  IssueOperationError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export type ProviderIssue = Omit<
  IssueListEntry,
  "provider" | "host" | "projectId" | "projectTitle" | "repository" | "observedAt"
>;
export type ProviderIssueDetail = ProviderIssue &
  Pick<IssueDetail, "body" | "comments" | "commentsTruncated">;
export interface IssueProviderApi {
  readonly getIssue: (input: {
    readonly host: string;
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<ProviderIssueDetail, IssueOperationError>;
  readonly kind: SourceControlProviderKind;
  readonly getViewer: (input: {
    readonly host: string;
    readonly cwd: string;
  }) => Effect.Effect<string, IssueOperationError>;
  readonly listIssues: (input: {
    readonly host: string;
    readonly cwd: string;
    readonly repository: string;
    readonly state: IssueListState;
    readonly limit: number;
    readonly query?: string;
    readonly filters?: IssueListFilters;
    readonly sort?: IssueListSort;
    readonly cursor?: string;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<ProviderIssue>; readonly nextCursor: string | null },
    IssueOperationError
  >;
}
