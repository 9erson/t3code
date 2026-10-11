import type { EnvironmentId, IssueListEntry, IssueListResult } from "@t3tools/contracts";

export interface EnvironmentIssue extends IssueListEntry {
  readonly environmentId: EnvironmentId;
  readonly viewer: string | null;
}

/** A failed environment contributes its error separately; answered lists remain usable. */
export function mergeIssueLists(values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>) {
  const entries = new Map<string, EnvironmentIssue>();
  for (const [environmentId, result] of values) {
    for (const entry of result.entries) {
      const key = `${entry.host.toLowerCase()} ${entry.repository.toLowerCase()} ${entry.number}`;
      const current = entries.get(key);
      if (current === undefined || (entry.observedAt ?? 0) > (current.observedAt ?? 0))
        entries.set(key, { ...entry, environmentId, viewer: result.viewers[entry.host] ?? null });
    }
  }
  return {
    entries: [...entries.values()],
    providers: values.flatMap(([environmentId, result]) =>
      result.providers.map((provider) => ({ ...provider, environmentId })),
    ),
    errors: values.flatMap(([environmentId, result]) =>
      result.errors.map((error) => ({ ...error, environmentId })),
    ),
    truncated: values.some(([, result]) => result.truncated),
    nextCursors: values.map(
      ([environmentId, result]) => [environmentId, result.nextCursors] as const,
    ),
  };
}

export function groupIssues(entries: ReadonlyArray<EnvironmentIssue>) {
  const groups: Array<{ title: string; entries: EnvironmentIssue[] }> = [
    { title: "Assigned to you", entries: [] },
    { title: "Created by you", entries: [] },
    { title: "Others", entries: [] },
  ];
  for (const entry of entries.toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )) {
    const viewer = entry.viewer?.toLowerCase();
    const index =
      viewer !== undefined && entry.assignees.some((actor) => actor.login.toLowerCase() === viewer)
        ? 0
        : viewer !== undefined && entry.author?.login.toLowerCase() === viewer
          ? 1
          : 2;
    groups[index]!.entries.push(entry);
  }
  return groups;
}
