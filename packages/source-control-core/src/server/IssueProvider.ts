import type {
  IssueListEntry,
  IssueListState,
  IssueOperationError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export type ProviderIssue = Omit<
  IssueListEntry,
  "provider" | "host" | "projectId" | "projectTitle" | "repository" | "observedAt"
>;
export interface IssueProviderApi {
  readonly kind: SourceControlProviderKind;
  readonly getViewer: (input: {
    readonly host: string;
    readonly cwd: string;
  }) => Effect.Effect<string, IssueOperationError>;
  readonly getIssue: (input: {
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
    readonly limit: number;
    readonly cursor?: string;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<ProviderIssue>; readonly nextCursor: string | null },
    IssueOperationError
  >;
}
