import type {
  IssueCreateInput,
  IssueActor,
  IssueAssigneeCandidatesInput,
  IssueDetail,
  IssueComment,
  IssueCommentInput,
  IssueSetStateInput,
  IssueState,
  IssueLabel,
  IssueLabelCandidatesInput,
  IssueSetLabelsInput,
  IssueListEntry,
  IssueListState,
  IssueListSort,
  IssueListInvolvement,
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
  readonly create: (
    input: Omit<IssueCreateInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<ProviderIssue, IssueOperationError>;
  readonly assigneeCandidates: (
    input: Omit<IssueAssigneeCandidatesInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<ReadonlyArray<IssueActor>, IssueOperationError>;
  readonly labelCandidates: (
    input: Omit<IssueLabelCandidatesInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<ReadonlyArray<IssueLabel>, IssueOperationError>;
  readonly setLabels: (
    input: Omit<IssueSetLabelsInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<ReadonlyArray<IssueLabel>, IssueOperationError>;
  readonly setState: (
    input: Omit<IssueSetStateInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<IssueState, IssueOperationError>;
  readonly comment: (
    input: Omit<IssueCommentInput, "projectId"> & { readonly cwd: string },
  ) => Effect.Effect<IssueComment, IssueOperationError>;
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
  readonly getIssueSummary: (input: {
    readonly host: string;
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<ProviderIssue, IssueOperationError>;
  readonly listIssues: (input: {
    readonly host: string;
    readonly cwd: string;
    readonly repository: string;
    readonly state: IssueListState;
    readonly involvement?: IssueListInvolvement;
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
