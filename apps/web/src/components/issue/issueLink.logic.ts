import {
  normalizeThreadIssueKey,
  threadIssueKeysEqual,
  type ThreadIssueKey,
} from "@t3tools/contracts";

/** Accept only an issue URL or a number in the thread's own GitHub repository. */
export function resolveIssueReference(
  reference: string,
  project: { host: string; repository: string } | null,
): ThreadIssueKey | null {
  const text = reference.trim();
  if (/^#?\d+$/.test(text)) {
    const number = Number(text.replace(/^#/, ""));
    return project !== null && Number.isSafeInteger(number) && number > 0
      ? normalizeThreadIssueKey({ ...project, number })
      : null;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
    if (match === null) return null;
    const number = Number(match[3]);
    return Number.isSafeInteger(number) && number > 0
      ? normalizeThreadIssueKey({
          host: url.hostname,
          repository: `${match[1]}/${match[2]}`,
          number,
        })
      : null;
  } catch {
    return null;
  }
}
export function availableIssuesToLink<T extends ThreadIssueKey & { title: string }>(
  entries: readonly T[],
  linked: readonly ThreadIssueKey[],
  search: string,
): T[] {
  const text = search.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      !linked.some((link) => threadIssueKeysEqual(link, entry)) &&
      `${entry.title} ${entry.repository} #${entry.number}`.toLowerCase().includes(text),
  );
}
