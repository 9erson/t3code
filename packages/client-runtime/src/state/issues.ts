import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:refreshes",
    tag: WS_METHODS.issuesSubscribeRefreshes,
  });
  return {
    refreshes,
    summary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:summary",
      tag: WS_METHODS.issuesSummary,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:linkedThreads",
      tag: WS_METHODS.issuesLinkedThreads,
      staleTimeMs: 0,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:link",
      tag: WS_METHODS.issuesLink,
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:unlink",
      tag: WS_METHODS.issuesUnlink,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
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
