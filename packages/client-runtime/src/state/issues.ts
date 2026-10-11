import {
  type IssueListResult,
  type IssueListInput,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}
export const ISSUE_LIST_MAX_PAGES = 10;

export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:refreshes",
    tag: WS_METHODS.issuesSubscribeRefreshes,
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:list",
    tag: WS_METHODS.issuesList,
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
  return {
    refreshes,
    list,
    listPages: Atom.family((key: string) =>
      Atom.make((get) => {
        const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
        const values = new Map<EnvironmentId, IssueListResult>();
        const errors: Cause.Cause<unknown>[] = [];
        let isPending = false;
        for (const target of targets) {
          const result = get(list(target));
          isPending ||= result.waiting || result._tag === "Initial";
          if (result._tag === "Failure") errors.push(result.cause);
          const value = Option.getOrNull(AsyncResult.value(result));
          if (value === null) continue;
          const previous = values.get(target.environmentId);
          values.set(
            target.environmentId,
            previous === undefined ? value : mergeIssueListPages(previous, value),
          );
        }
        return { values: [...values.entries()], errors, isPending };
      }),
    ),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:detail",
      tag: WS_METHODS.issuesDetail,
      staleTimeMs: 60_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:invalidate",
      tag: WS_METHODS.issuesInvalidate,
    }),
  };
}

/** A continuation replaces cursor state, but retains rows and hosts from exhausted repositories. */
export function mergeIssueListPages(
  previous: IssueListResult,
  next: IssueListResult,
): IssueListResult {
  const entries = new Map(
    previous.entries.map((entry) => [
      `${entry.host.toLowerCase()} ${entry.repository.toLowerCase()} ${entry.number}`,
      entry,
    ]),
  );
  for (const entry of next.entries) {
    const key = `${entry.host.toLowerCase()} ${entry.repository.toLowerCase()} ${entry.number}`;
    const old = entries.get(key);
    if (old === undefined || (entry.observedAt ?? 0) >= (old.observedAt ?? 0))
      entries.set(key, entry);
  }
  const providers = new Map(previous.providers.map((provider) => [provider.host, provider]));
  for (const provider of next.providers) providers.set(provider.host, provider);
  const errors = new Map(previous.errors.map((error) => [error.projectId, error]));
  for (const entry of next.entries) errors.delete(entry.projectId);
  for (const error of next.errors) errors.set(error.projectId, error);
  return {
    ...next,
    viewers: { ...previous.viewers, ...next.viewers },
    entries: [...entries.values()],
    providers: [...providers.values()],
    errors: [...errors.values()],
  };
}

/** Cursor-less environments are exhausted; every continuation keeps the original bounded limit. */
export function issueListNextPage(
  targets: ReadonlyArray<IssueListTarget>,
  values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pagesRead: number,
): ReadonlyArray<IssueListTarget> {
  if (pagesRead >= ISSUE_LIST_MAX_PAGES) return [];
  return targets.flatMap((target) => {
    const result = values.find(([environmentId]) => environmentId === target.environmentId)?.[1];
    if (!result || Object.keys(result.nextCursors).length === 0) return [];
    return [{ ...target, input: { ...target.input, cursors: result.nextCursors } }];
  });
}
