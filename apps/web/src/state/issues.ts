import { useAtomValue } from "@effect/atom-react";
import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueListResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { mergeIssueLists } from "../components/issue/issueList.logic";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
interface Target {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}
const lists = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<Target>;
    const values: Array<readonly [EnvironmentId, IssueListResult]> = [];
    const errors: string[] = [];
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting || result._tag === "Initial";
      if (result._tag === "Failure") errors.push(formatEnvironmentQueryError(result.cause));
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) values.push([target.environmentId, value]);
    }
    return { values, errors, isPending };
  }),
);

export function useIssueList(targets: ReadonlyArray<Target>) {
  const key = JSON.stringify(targets);
  const query = useAtomValue(lists(key));
  const data = useMemo(
    () => (query.values.length === 0 ? null : mergeIssueLists(query.values)),
    [query.values],
  );
  const refresh = useCallback(() => {
    for (const target of JSON.parse(key) as Target[])
      appAtomRegistry.refresh(issueEnvironment.list(target));
  }, [key]);
  return { data, errors: query.errors, isPending: query.isPending, refresh };
}
