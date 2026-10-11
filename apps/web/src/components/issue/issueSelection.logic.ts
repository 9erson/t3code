import { EnvironmentId, IssueRef, type IssueListState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Selection = Schema.Struct({ ...IssueRef.fields, environmentId: EnvironmentId });
export type IssueSelection = typeof Selection.Type;
export interface IssuesSearch {
  readonly state: IssueListState;
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: IssueRef["projectId"];
  readonly selectedHost?: string;
  readonly repository?: string;
  readonly number?: number;
}
const decode = Schema.decodeUnknownOption(Selection);

/** The URL identifies the detail even when the current list does not contain the issue. */
export function issueSelectionFromSearch(search: Record<string, unknown>): IssueSelection | null {
  return Option.getOrNull(
    decode({
      environmentId: search.selectedEnvironmentId,
      projectId: search.selectedProjectId,
      host: search.selectedHost,
      repository: search.repository,
      number: typeof search.number === "string" ? Number(search.number) : search.number,
    }),
  );
}

export function issueSelectionSearch(
  selection: IssueSelection | null,
): Omit<IssuesSearch, "state"> {
  if (selection === null) return {};
  return {
    selectedEnvironmentId: selection.environmentId,
    selectedProjectId: selection.projectId,
    selectedHost: selection.host,
    repository: selection.repository,
    number: selection.number,
  };
}

/** Remove only the detail selection; list filters remain in the URL. */
export function clearIssueSelectionSearch<T extends IssuesSearch>(search: T) {
  const {
    selectedEnvironmentId: _environmentId,
    selectedProjectId: _projectId,
    selectedHost: _host,
    repository: _repository,
    number: _number,
    ...rest
  } = search;
  return rest;
}
