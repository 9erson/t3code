import { CircleCheckIcon, CircleDotIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { openIssueOnGitHub } from "./issueLinkActions";
import { PullRequestTimelineGhost } from "../pullRequest/PullRequestGhosts";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { IssueDetailActions } from "./IssueDetailActions";
import type { IssueSelection } from "./issueSelection.logic";

export function IssueDetailPanel({
  selection,
  supported,
  onClose,
}: {
  selection: IssueSelection;
  supported: boolean;
  onClose: () => void;
}) {
  const { environmentId, projectId, host, repository, number } = selection;
  const reference = { projectId, host, repository, number };
  const atom = useMemo(
    () =>
      supported
        ? issueEnvironment.detail({ environmentId, input: { projectId, host, repository, number } })
        : null,
    [supported, environmentId, projectId, host, repository, number],
  );
  const query = useEnvironmentQuery(atom);
  const detail = query.data;
  const url =
    detail?.url ??
    `https://${reference.host}/${reference.repository.split("/").map(encodeURIComponent).join("/")}/issues/${reference.number}`;
  const markdownContext = useMemo(
    () => ({ repositoryUrl: `https://${reference.host}/${reference.repository}`, threadRef: null }),
    [reference.host, reference.repository],
  );
  const error = !supported
    ? "Connect to the environment that owns this issue, or update its server to support issues."
    : query.error;
  const Icon = detail?.state === "closed" ? CircleCheckIcon : CircleDotIcon;
  return (
    <aside
      aria-label={`Issue #${reference.number} details`}
      className="flex h-full min-h-0 w-full flex-col border-l bg-background md:w-[min(48%,40rem)] md:shrink-0"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {reference.repository} #{reference.number}
        </span>
        <Button variant="ghost" size="sm" onClick={() => void openIssueOnGitHub(url)}>
          <ExternalLinkIcon aria-hidden className="size-3.5" /> Open on GitHub
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close issue details" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        {error && !detail ? (
          <Empty>
            <EmptyMedia variant="icon">
              <CircleDotIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                {!supported
                  ? "Issue is unavailable"
                  : query.failure &&
                      "reason" in query.failure &&
                      query.failure.reason === "not-found"
                    ? `Issue #${reference.number} not found`
                    : "Could not load issue"}
              </EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            {supported ? (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isPending}
                onClick={query.refresh}
              >
                Retry
              </Button>
            ) : null}
          </Empty>
        ) : detail ? (
          <PullRequestMarkdownContext value={markdownContext}>
            <div className="space-y-5 px-4 py-4">
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <header className="space-y-3">
                <h2 className="text-lg font-semibold break-words">{detail.title}</h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${detail.state === "open" ? "text-success" : "text-primary"}`}
                  >
                    <Icon className="size-4" />
                    {detail.state === "open" ? "Open" : "Closed"}
                  </span>
                  <span>
                    {detail.author?.login ?? "Unknown author"} opened{" "}
                    <time dateTime={detail.createdAt}>
                      {formatRelativeTimeLabel(detail.createdAt)}
                    </time>
                  </span>
                </div>
                {detail.labels.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {detail.labels.map((label) => (
                      <PullRequestLabelChip key={label.name} label={label} />
                    ))}
                  </div>
                ) : null}
              </header>
              <section aria-label="Issue description">
                {detail.body.trim() ? (
                  <PullRequestMarkdown
                    text={detail.body}
                    cwd={detail.workspaceRoot}
                    environmentId={environmentId}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No description provided.</p>
                )}
              </section>
              <section aria-label="Comment timeline" className="space-y-4 border-t pt-4">
                <h3 className="text-sm font-medium">Comments</h3>
                {detail.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                ) : (
                  detail.comments.map((comment) => (
                    <article key={comment.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {comment.id === -1
                            ? "You · Sending…"
                            : (comment.author?.login ?? "Unknown author")}
                        </span>
                        <a
                          href={comment.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            void openIssueOnGitHub(comment.url);
                          }}
                        >
                          <time dateTime={comment.createdAt}>
                            {formatRelativeTimeLabel(comment.createdAt)}
                          </time>
                        </a>
                      </div>
                      {comment.body.trim() ? (
                        <PullRequestMarkdown
                          text={comment.body}
                          cwd={detail.workspaceRoot}
                          environmentId={environmentId}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">Empty comment.</p>
                      )}
                    </article>
                  ))
                )}
                {detail.commentsTruncated ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    More comments are available on GitHub.
                  </p>
                ) : null}
              </section>
              <IssueDetailActions
                key={`${environmentId}/${projectId}/${host}/${repository}/${number}`}
                selection={selection}
                detail={detail}
              />
            </div>
          </PullRequestMarkdownContext>
        ) : (
          <div role="status" aria-label="Loading issue details">
            <PullRequestTimelineGhost />
          </div>
        )}
      </div>
    </aside>
  );
}
