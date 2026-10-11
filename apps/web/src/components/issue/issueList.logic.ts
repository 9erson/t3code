import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  IssueListSort,
  IssueListState,
} from "@t3tools/contracts";

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

export function groupIssues(
  entries: ReadonlyArray<EnvironmentIssue>,
  sort: IssueListSort = "updated",
) {
  const groups: Array<{ title: string; entries: EnvironmentIssue[] }> = [
    { title: "Assigned to you", entries: [] },
    { title: "Created by you", entries: [] },
    { title: "Others", entries: [] },
  ];
  const compare = (left: EnvironmentIssue, right: EnvironmentIssue) => {
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    const ordered =
      sort === "comments"
        ? right.commentCount - left.commentCount
        : sort === "newest"
          ? Date.parse(right.createdAt) - Date.parse(left.createdAt)
          : sort === "oldest"
            ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
            : updated;
    return ordered || updated || left.url.localeCompare(right.url);
  };
  for (const entry of entries.toSorted(compare)) {
    const index = { assigned: 0, authored: 1, others: 2 }[issueInvolvement(entry)];
    groups[index]!.entries.push(entry);
  }
  return groups;
}

export function issueInvolvement(entry: EnvironmentIssue): "assigned" | "authored" | "others" {
  const viewer = entry.viewer?.toLowerCase();
  return viewer !== undefined &&
    entry.assignees.some((actor) => actor.login.toLowerCase() === viewer)
    ? "assigned"
    : viewer !== undefined && entry.author?.login.toLowerCase() === viewer
      ? "authored"
      : "others";
}

export function filterIssues(
  entries: ReadonlyArray<EnvironmentIssue>,
  filters: {
    readonly state: IssueListState;
    readonly involvement?: "all" | "assigned" | "authored" | "others";
    readonly author?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly projectId?: string | undefined;
    readonly environmentId?: string | undefined;
    readonly host?: string | undefined;
  },
) {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (!filters.environmentId || entry.environmentId === filters.environmentId) &&
      (!filters.projectId || entry.projectId === filters.projectId) &&
      (!filters.host || entry.host.toLowerCase() === filters.host.toLowerCase()) &&
      (!filters.author || entry.author?.login.toLowerCase() === filters.author.toLowerCase()) &&
      (filters.labels ?? []).every((label) =>
        entry.labels.some((value) => value.name.toLowerCase() === label.toLowerCase()),
      ) &&
      (!filters.involvement ||
        filters.involvement === "all" ||
        issueInvolvement(entry) === filters.involvement),
  );
}
