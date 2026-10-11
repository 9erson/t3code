import type { EnvironmentId, IssueRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { findProjectForChangeRequest } from "~/lib/openPullRequestLink";
import type { IssueSelection } from "./issueSelection.logic";
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

export interface IssueLinkTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueRef;
}

export interface IssueLinkActivationEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function shouldOpenIssueExternally(event: IssueLinkActivationEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/** An issue must be readable before replacing the ordinary link's browser destination. */
export async function resolveIssueLinkActivation({
  target,
  event,
  readDetail,
}: {
  target: IssueLinkTarget;
  event: IssueLinkActivationEvent;
  readDetail: (target: IssueLinkTarget) => Promise<IssueRef | null>;
}): Promise<IssueSelection | null> {
  if (shouldOpenIssueExternally(event)) return null;
  try {
    const detail = await readDetail(target);
    return detail === null ? null : { environmentId: target.environmentId, ...target.input };
  } catch {
    // A failed enrichment leaves the original browser destination available.
    return null;
  }
}

/** Match the GitHub issue URL shape supported by the source-control link resolver. */
export function resolveIssueLinkTarget({
  environmentId,
  projects,
  issuesEnabled,
  url: targetUrl,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">>;
  issuesEnabled: boolean;
  url: string;
}): IssueLinkTarget | null {
  if (!issuesEnabled || environmentId === null) return null;
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host !== "github.com" || url.username || url.password)
    return null;
  const match = /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)(?:\/.*)?$/u.exec(url.pathname);
  if (!match?.[1] || !Number.isSafeInteger(Number(match[2]))) return null;
  const parsed = { host: url.host, repository: match[1].toLowerCase(), number: Number(match[2]) };
  const project = findProjectForChangeRequest(
    projects.filter(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.repositoryIdentity?.provider === "github",
    ),
    parsed,
  );
  if (project === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: project.id,
      host: parsed.host,
      repository: sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository,
      number: parsed.number,
    },
  };
}
