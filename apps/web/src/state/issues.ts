import { useAtomValue } from "@effect/atom-react";
import {
  createIssueEnvironmentAtoms,
  createIssueWorkCommand,
  issueListNextPage,
  ISSUE_LIST_MAX_PAGES,
} from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { mergeIssueLists } from "../components/issue/issueList.logic";
import {
  readIssueListSnapshot,
  writeIssueListSnapshot,
} from "../components/issue/issueListPreferences";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
export const workOnIssueCommand = createIssueWorkCommand(connectionAtomRuntime);
interface Target {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export function useIssueList(targets: ReadonlyArray<Target>) {
  const scopeKey = JSON.stringify(targets);
  const [paging, setPaging] = useState<{
    key: string;
    batches: ReadonlyArray<ReadonlyArray<Target>>;
  }>({ key: scopeKey, batches: [targets] });
  if (paging.key !== scopeKey) setPaging({ key: scopeKey, batches: [targets] });
  const batches = paging.key === scopeKey ? paging.batches : [targets];
  const key = JSON.stringify(batches.flat());
  const query = useAtomValue(issueEnvironment.listPages(key));
  // Reading synchronously lets the first render carry the saved list before live RPCs finish.
  const snapshot = useMemo(() => readIssueListSnapshot(scopeKey), [scopeKey]);
  const data = useMemo(() => {
    const values = new Map(snapshot ?? []);
    for (const [environmentId, value] of query.values) values.set(environmentId, value);
    return values.size === 0 ? null : mergeIssueLists([...values.entries()]);
  }, [query.values, snapshot]);
  useEffect(() => {
    if (query.values.length > 0 && !query.isPending && query.errors.length === 0)
      writeIssueListSnapshot(scopeKey, query.values);
  }, [query, scopeKey]);
  const refresh = useCallback(() => {
    for (const target of JSON.parse(key) as Target[])
      appAtomRegistry.refresh(issueEnvironment.list(target));
  }, [key]);
  const loadMore = () => {
    if (query.isPending || batches.length >= ISSUE_LIST_MAX_PAGES) return;
    const next = issueListNextPage(targets, query.values, batches.length);
    if (next.length > 0) setPaging({ key: scopeKey, batches: [...batches, next] });
  };
  return {
    data,
    errors: query.errors.map(formatEnvironmentQueryError),
    isPending: query.isPending,
    refresh,
    loadMore,
    canLoadMore:
      batches.length < ISSUE_LIST_MAX_PAGES &&
      query.values.some(([, value]) => Object.keys(value.nextCursors).length > 0),
    pageLimitReached:
      batches.length >= ISSUE_LIST_MAX_PAGES && query.values.some(([, value]) => value.truncated),
    showingSnapshot:
      snapshot?.some(
        ([environmentId]) => !query.values.some(([answeredId]) => answeredId === environmentId),
      ) ?? false,
  };
}
