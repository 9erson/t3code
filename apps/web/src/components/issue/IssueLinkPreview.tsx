import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, CircleDotIcon, MessageSquareIcon } from "lucide-react";
import {
  cloneElement,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from "react";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveIssueLinkActivation,
  shouldOpenIssueExternally,
  type IssueLinkTarget,
} from "./issueLink.logic";
import { issueSelectionSearch } from "./issueSelection.logic";

/** Read on hover or activation, using the same detail cache as the Issues page. */
export function IssueLinkPreview({
  link,
  originalUrl,
  target,
  onOpenFallback,
}: {
  link: ReactElement<ComponentPropsWithoutRef<"a">>;
  originalUrl: string;
  target: IssueLinkTarget;
  onOpenFallback: (url: string) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [resolvingClick, setResolvingClick] = useState(false);
  const previewActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const detailQuery = useEnvironmentQuery(open ? issueEnvironment.detail(target) : null);
  const readDetail = useAtomQueryRunner(issueEnvironment.detail, {
    reportFailure: false,
    reportDefect: false,
  });
  const detail = detailQuery.data;
  const showUrlTooltip = open && detailQuery.error !== null && detail === null;
  const StateIcon = detail?.state === "closed" ? CircleCheckIcon : CircleDotIcon;
  const trigger = cloneElement(link, {
    onClick: (event) => {
      if (event.defaultPrevented || shouldOpenIssueExternally(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (resolvingClick) return;
      setResolvingClick(true);
      setOpen(false);
      void resolveIssueLinkActivation({
        target,
        event,
        readDetail: async (selectedTarget) => {
          const result = await readDetail(selectedTarget);
          return result._tag === "Success" ? result.value : null;
        },
      })
        .then(async (selection) => {
          if (selection === null) {
            await onOpenFallback(originalUrl);
            return;
          }
          await navigate({
            to: "/issues",
            search: { state: "all", ...issueSelectionSearch(selection) },
          });
        })
        .catch((error: unknown) => {
          console.error("[issue-link-preview] failed to open link", error);
        })
        .finally(() => {
          setResolvingClick(false);
        });
    },
  });

  return (
    <PreviewCard open={open} onOpenChange={setOpen} actionsRef={previewActionsRef}>
      <Tooltip
        open={showUrlTooltip}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && detail === null) previewActionsRef.current?.close();
        }}
      >
        <PreviewCardTrigger
          render={<TooltipTrigger render={trigger} />}
          delay={350}
          closeDelay={120}
        />
        <TooltipPopup side="top">{originalUrl}</TooltipPopup>
      </Tooltip>
      {detail === null ? null : (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="min-w-0 p-3">
            <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
              <span className="min-w-0 truncate">{detail.repository}</span>
              <span className="shrink-0">#{detail.number}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <StateIcon
                  aria-hidden
                  className={
                    detail.state === "closed"
                      ? "size-3 text-muted-foreground"
                      : "size-3 text-success"
                  }
                />
                {detail.state === "closed" ? "Closed" : "Open"}
              </span>
            </div>
            <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
              {detail.title}
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <PullRequestActorAvatar actor={detail.author} className="size-4" />
              <span className="min-w-0 truncate">{detail.author?.login ?? "ghost"}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">opened {formatRelativeTimeLabel(detail.createdAt)}</span>
              <MessageSquareIcon aria-hidden className="size-3 shrink-0" />
              <span aria-label={`${detail.commentCount} comments`}>{detail.commentCount}</span>
            </div>
          </div>
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}
