import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { InlineButton } from "../ui/button";
import { IssueGlyph } from "./issuePresentation";

function IssueChip({
  link,
  threadRef,
  refreshCurrentState,
  onOpen,
}: {
  link: ThreadIssueLink;
  threadRef: ScopedThreadRef;
  refreshCurrentState: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const configs = useServerConfigs();
  const query = useEnvironmentQuery(
    refreshCurrentState &&
      configs.get(threadRef.environmentId)?.environment.capabilities.issues === true
      ? issueEnvironment.summary({
          environmentId: threadRef.environmentId,
          input: { host: link.host, repository: link.repository, number: link.number },
        })
      : null,
  );
  const snapshot = query.data ?? link.snapshot;
  return (
    <InlineButton
      title={`${link.repository} #${link.number}: ${snapshot.title} (${snapshot.state})`}
      onClick={(event) => {
        event.stopPropagation();
        useRightPanelStore.getState().open(threadRef, "issues");
        onOpen?.();
      }}
    >
      <IssueGlyph state={snapshot.state} />#{link.number}
    </InlineButton>
  );
}

/** Only the active thread revalidates chips; other sidebar rows use their persisted snapshots. */
export function ThreadIssueChips({
  links,
  threadRef,
  refreshCurrentState,
  onOpen,
}: {
  links: readonly ThreadIssueLink[];
  threadRef: ScopedThreadRef;
  refreshCurrentState: boolean;
  onOpen?: () => void;
}) {
  if (links.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {links.slice(0, 2).map((link) => (
        <IssueChip
          key={`${link.host}/${link.repository}#${link.number}`}
          link={link}
          threadRef={threadRef}
          refreshCurrentState={refreshCurrentState}
          onOpen={onOpen}
        />
      ))}
      {links.length > 2 ? (
        <InlineButton
          onClick={(event) => {
            event.stopPropagation();
            useRightPanelStore.getState().open(threadRef, "issues");
            onOpen?.();
          }}
        >
          +{links.length - 2}
        </InlineButton>
      ) : null}
    </span>
  );
}
