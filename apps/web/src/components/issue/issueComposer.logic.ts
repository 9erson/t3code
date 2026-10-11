import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import type { Project } from "~/types";
import {
  pullRequestHostOf,
  IssueCreateInput,
  IssueOperationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type IssueComposerDraft = Pick<IssueCreateInput, "title" | "body" | "labels" | "assignees">;

const decodeCreate = Schema.decodeResult(IssueCreateInput);

export function prepareIssueCreate(
  target: Pick<IssueCreateInput, "projectId" | "host" | "repository"> & {
    environmentId: EnvironmentId;
  },
  draft: IssueComposerDraft,
) {
  return decodeCreate({
    projectId: target.projectId,
    host: target.host,
    repository: target.repository,
    ...draft,
  }).pipe(
    Result.mapError(
      (cause) => new IssueOperationError({ host: target.host, reason: "invalid-input", cause }),
    ),
  );
}

interface IssueComposerState {
  readonly draft: IssueComposerDraft;
  readonly pending: boolean;
  readonly error: string | null;
}
export const initialIssueComposerState: IssueComposerState = {
  draft: { title: "", body: "", labels: [], assignees: [] },
  pending: false,
  error: null,
};
type IssueComposerAction =
  | { type: "edit"; patch: Partial<IssueComposerDraft> }
  | { type: "submit" }
  | { type: "failure"; error: string }
  | { type: "success" };

export function issueComposerReducer(
  state: IssueComposerState,
  action: IssueComposerAction,
): IssueComposerState {
  switch (action.type) {
    case "edit":
      return { ...state, draft: { ...state.draft, ...action.patch }, error: null };
    case "submit":
      return { ...state, pending: true, error: null };
    case "failure":
      return { ...state, pending: false, error: action.error };
    case "success":
      return initialIssueComposerState;
  }
}

export function issueCreationTargets(
  projects: ReadonlyArray<Pick<Project, "id" | "environmentId" | "title" | "repositoryIdentity">>,
  environmentIds: ReadonlyArray<EnvironmentId>,
) {
  return projects.flatMap((project) => {
    const identity = project.repositoryIdentity;
    const repository = sourceControlRepositorySelector(identity);
    if (
      !environmentIds.includes(project.environmentId) ||
      identity?.provider !== "github" ||
      repository === null
    )
      return [];
    return [
      {
        key: `${project.environmentId}:${project.id}:${pullRequestHostOf(identity, "github")}/${repository}`,
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        host: pullRequestHostOf(identity, "github"),
        repository,
      },
    ];
  });
}
export type IssueCreationTarget = ReturnType<typeof issueCreationTargets>[number];
