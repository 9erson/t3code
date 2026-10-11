import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { useRightPanelStore } from "~/rightPanelStore";
import { InlineButton } from "../ui/button";
import { IssueGlyph } from "./issuePresentation";

/** Persisted thread state keeps chips available without one network subscription per sidebar row. */
export function ThreadIssueChips({
  links,
  threadRef,
  onOpen,
}: {
  links: readonly ThreadIssueLink[];
  threadRef: ScopedThreadRef;
  onOpen?: () => void;
}) {
  if (links.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {links.slice(0, 2).map((link) => (
        <InlineButton
          key={`${link.host}/${link.repository}#${link.number}`}
          title={`${link.repository} #${link.number}: ${link.snapshot.title} (${link.snapshot.state})`}
          onClick={(event) => {
            event.stopPropagation();
            useRightPanelStore.getState().open(threadRef, "issues");
            onOpen?.();
          }}
        >
          <IssueGlyph state={link.snapshot.state} />#{link.number}
        </InlineButton>
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
