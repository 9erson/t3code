import { createFileRoute } from "@tanstack/react-router";
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { IssueListState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarTrigger } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { RefreshIcon } from "../components/ui/refresh-icon";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { PullRequestLabelChip } from "../components/pullRequest/pullRequestPresentation";
import { openIssueOnGitHub } from "../components/issue/issueLinkActions";
import {
  clearIssueSelectionSearch,
  issueSelectionFromSearch,
  issueSelectionSearch,
  type IssuesSearch,
} from "../components/issue/issueSelection.logic";
import { showPullRequestLinkContextMenu } from "../components/pullRequest/pullRequestLinkContextMenu";
import { groupIssues } from "../components/issue/issueList.logic";
import { useEnvironments } from "../state/environments";
import { issueEnvironment, useIssueList } from "../state/issues";
import { formatEnvironmentQueryError } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { isElectron } from "../env";
import { formatRelativeTimeLabel } from "../timestampFormat";

const IssueDetailPanel = lazy(() =>
  import("../components/issue/IssueDetailPanel").then((module) => ({
    default: module.IssueDetailPanel,
  })),
);
const decodeState = Schema.decodeUnknownOption(IssueListState);

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (search: Record<string, unknown>): IssuesSearch => ({
    state: Option.getOrElse(decodeState(search.state), () => "open"),
    ...issueSelectionSearch(issueSelectionFromSearch(search)),
  }),
  component: IssuesPage,
});

function IssuesPage() {
  const search = Route.useSearch();
  const { state } = search;
  const selection = issueSelectionFromSearch(search);
  const navigate = Route.useNavigate();
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.issues === true)
        .map((environment) => environment.environmentId),
    [environments],
  );
  const targets = useMemo(
    () => environmentIds.map((environmentId) => ({ environmentId, input: { state } })),
    [environmentIds, state],
  );
  const query = useIssueList(targets);
  const groups = useMemo(() => groupIssues(query.data?.entries ?? []), [query.data]);
  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const [invalidating, setInvalidating] = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const refreshing = invalidating || query.isPending;
  const refresh = async () => {
    setInvalidating(true);
    try {
      const answers = await Promise.allSettled(
        environmentIds.map((environmentId) => invalidate({ environmentId, input: {} })),
      );
      setRefreshErrors(
        answers.flatMap((answer) =>
          answer.status === "rejected"
            ? ["Could not refresh an environment. Check its connection and retry."]
            : answer.value._tag === "Failure"
              ? [formatEnvironmentQueryError(answer.value.cause)]
              : [],
        ),
      );
      query.refresh();
    } finally {
      setInvalidating(false);
    }
  };
  const errors = [...query.errors, ...refreshErrors];
  const unsupported = environmentIds.length === 0;
  const unavailable = query.data === null && errors.length > 0;
  const empty = query.data !== null && query.data.entries.length === 0;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <div className="[-webkit-app-region:no-drag]">
          <SidebarTrigger />
        </div>
        <h1 className="text-sm font-medium">Issues</h1>
        <div className="flex-1" />
        <div className="[-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={unsupported || refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon size="sm" refreshing={refreshing} /> Refresh
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="flex gap-1 border-b px-4 py-2" role="group" aria-label="Issue state">
        {(["open", "all"] as const).map((tab) => (
          <Button
            key={tab}
            variant={tab === state ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={tab === state}
            onClick={() => void navigate({ search: (previous) => ({ ...previous, state: tab }) })}
          >
            {tab === "open" ? "Open" : "All"}
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className={`scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 ${selection ? "hidden md:block" : ""}`}
        >
          {[...new Set(errors)].map((error) => (
            <p role="alert" key={error} className="mb-3 text-sm text-destructive">
              {error}
            </p>
          ))}
          {query.data?.providers
            .filter((provider) => provider.detail !== null)
            .map((provider) => (
              <p
                key={`${provider.environmentId}:${provider.host}`}
                role="status"
                className="mb-3 text-sm text-muted-foreground"
              >
                <span className="font-medium">{provider.host}: </span>
                {provider.detail}
              </p>
            ))}
          {query.data?.errors.map((error) => (
            <p
              key={`${error.environmentId}:${error.projectId}`}
              className="mb-2 text-xs text-muted-foreground"
            >
              {error.projectTitle}: {error.message}
            </p>
          ))}
          {unsupported || unavailable || empty ? (
            <Empty>
              <EmptyMedia variant="icon">
                <CircleDotIcon />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>
                  {unsupported
                    ? "Issues are unavailable"
                    : unavailable
                      ? "Could not load issues"
                      : "No issues"}
                </EmptyTitle>
                <EmptyDescription>
                  {unsupported
                    ? "Connect to an environment that supports issues, or update your server."
                    : unavailable
                      ? errors[0]
                      : state === "open"
                        ? "There are no open issues in your configured GitHub projects."
                        : "There are no issues in your configured GitHub projects."}
                </EmptyDescription>
              </EmptyHeader>
              {unavailable ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  Retry
                </Button>
              ) : null}
            </Empty>
          ) : query.data === null ? (
            <PullRequestListGhost caption="Loading issues" />
          ) : (
            groups.map((group) =>
              group.entries.length === 0 ? null : (
                <section key={group.title} className="mb-5">
                  <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">
                    {group.title} <span className="tabular-nums">{group.entries.length}</span>
                  </h2>
                  {group.entries.map((entry) => {
                    const Icon = entry.state === "open" ? CircleDotIcon : CircleCheckIcon;
                    return (
                      <a
                        key={`${entry.host}:${entry.repository}:${entry.number}`}
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-current={
                          selection?.environmentId === entry.environmentId &&
                          selection.projectId === entry.projectId &&
                          selection.host === entry.host &&
                          selection.repository === entry.repository &&
                          selection.number === entry.number
                            ? "true"
                            : undefined
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          if (event.metaKey || event.ctrlKey) {
                            void openIssueOnGitHub(entry.url);
                            return;
                          }
                          void navigate({
                            search: (previous) => ({ ...previous, ...issueSelectionSearch(entry) }),
                          });
                        }}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-3 py-2.5 hover:bg-accent aria-[current=true]:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Icon
                          aria-label={entry.state}
                          className={`mt-0.5 size-4 ${entry.state === "open" ? "text-success" : "text-primary"}`}
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{entry.title}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {entry.host} · {entry.repository}{" "}
                            <span
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void showPullRequestLinkContextMenu({
                                  url: entry.url,
                                  openLabel: "Open on GitHub",
                                  position: { x: event.clientX, y: event.clientY },
                                });
                              }}
                            >
                              #{entry.number}
                            </span>{" "}
                            · {entry.author?.login ?? "Unknown author"}
                          </p>
                          {entry.labels.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {entry.labels.map((label) => (
                                <PullRequestLabelChip key={label.name} label={label} />
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
                          <time dateTime={entry.updatedAt}>
                            {formatRelativeTimeLabel(entry.updatedAt)}
                          </time>
                          {entry.commentCount > 0 ? (
                            <span
                              className="flex items-center gap-1"
                              aria-label={`${entry.commentCount} comments`}
                            >
                              <MessageSquareIcon aria-hidden className="size-3" />
                              {entry.commentCount}
                            </span>
                          ) : null}
                        </div>
                      </a>
                    );
                  })}
                </section>
              ),
            )
          )}
          {query.data?.truncated ? (
            <p className="px-3 text-xs text-muted-foreground">
              Some repositories have more issues than this list can show.
            </p>
          ) : null}
        </div>
        {selection ? (
          <Suspense
            fallback={
              <div
                role="status"
                aria-label="Loading issue details"
                className="w-full border-l md:w-[48%] md:shrink-0"
              >
                <PullRequestListGhost rows={3} caption="Loading issue details" />
              </div>
            }
          >
            <IssueDetailPanel
              key={JSON.stringify(selection)}
              selection={selection}
              supported={environmentIds.includes(selection.environmentId)}
              onClose={() =>
                void navigate({
                  search: (previous) => clearIssueSelectionSearch(previous),
                })
              }
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
