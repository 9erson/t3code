import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { useState } from "react";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { IssueGlyph } from "./issuePresentation";
import { openLinkIssueDialog } from "./LinkIssueDialog";

function IssueRow({ link, threadRef }: { link: ThreadIssueLink; threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    issueEnvironment.summary({
      environmentId: threadRef.environmentId,
      input: { host: link.host, repository: link.repository, number: link.number },
    }),
  );
  const snapshot = query.data ?? link.snapshot;
  const unlink = useAtomCommand(issueEnvironment.unlink);
  const allowed = useAtomValue(issueEnvironment.unlink.permissionAtom(threadRef.environmentId));
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <IssueGlyph state={snapshot.state} />
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-sm"
        >
          #{link.number} {snapshot.title}
        </a>
        <Button
          size="xs"
          variant="ghost"
          disabled={!allowed || pending}
          onClick={() => {
            setPending(true);
            void unlink({
              environmentId: threadRef.environmentId,
              input: {
                threadId: threadRef.threadId,
                host: link.host,
                repository: link.repository,
                number: link.number,
              },
            }).finally(() => setPending(false));
          }}
        >
          Unlink
        </Button>
      </div>
      <span className="truncate text-xs text-muted-foreground">
        {link.host}/{link.repository} · {snapshot.state}
      </span>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error} Showing the last saved state.
        </p>
      ) : null}
    </div>
  );
}
export function ThreadIssuesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const configs = useServerConfigs();
  const canLink = useAtomValue(issueEnvironment.link.permissionAtom(threadRef.environmentId));
  if (configs.get(threadRef.environmentId)?.environment.capabilities.issues !== true)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Linked issues are unavailable in this environment.
      </p>
    );
  const links = thread?.issues ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 p-2">
        <span className="text-sm">{links.length} linked issues</span>
        <Button
          size="xs"
          variant="outline"
          disabled={!canLink}
          onClick={() => openLinkIssueDialog(threadRef)}
        >
          Link issue
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {links.map((link) => (
          <IssueRow
            key={`${link.host}/${link.repository}#${link.number}`}
            link={link}
            threadRef={threadRef}
          />
        ))}
        {links.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No linked issues. Link an issue to keep it with this thread.
          </p>
        ) : null}
      </div>
    </div>
  );
}
