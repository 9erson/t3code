import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { pullRequestHostOf, type ScopedThreadRef, type ThreadIssueKey } from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { useMemo, useState } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useServerConfigs, useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { availableIssuesToLink, resolveIssueReference } from "./issueLink.logic";
import { IssueGlyph } from "./issuePresentation";

const dialogThread = Atom.make<ScopedThreadRef | null>(null).pipe(Atom.keepAlive);
export function openLinkIssueDialog(threadRef: ScopedThreadRef) {
  appAtomRegistry.set(dialogThread, threadRef);
}
export function LinkIssueDialogHost() {
  const threadRef = useAtomValue(dialogThread);
  const configs = useServerConfigs();
  if (
    threadRef === null ||
    configs.get(threadRef.environmentId)?.environment.capabilities.issues !== true
  )
    return null;
  return (
    <LinkIssueDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  );
}
function LinkIssueDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const canLink = useAtomValue(issueEnvironment.link.permissionAtom(threadRef.environmentId));
  const link = useAtomCommand(issueEnvironment.link);
  const list = useEnvironmentQuery(
    issueEnvironment.list({
      environmentId: threadRef.environmentId,
      input: { state: "all", limit: 100 },
    }),
  );
  const ownProject = useMemo(() => {
    const identity = projects.find(
      (project) =>
        project.environmentId === threadRef.environmentId && project.id === thread?.projectId,
    )?.repositoryIdentity;
    const repository = sourceControlRepositorySelector(identity);
    return identity?.provider === "github" && repository !== null
      ? { host: pullRequestHostOf(identity, "github"), repository }
      : null;
  }, [projects, threadRef.environmentId, thread?.projectId]);
  const reference = resolveIssueReference(search, ownProject);
  const candidates = availableIssuesToLink(list.data?.entries ?? [], thread?.issues ?? [], search);
  const attach = async (key: ThreadIssueKey) => {
    setPending(true);
    try {
      const result = await link({
        environmentId: threadRef.environmentId,
        input: { ...key, threadId: threadRef.threadId },
      });
      if (result._tag === "Success") appAtomRegistry.set(dialogThread, null);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(dialogThread, null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Link issue</DialogTitle>
          <DialogDescription>
            Find an existing issue, paste its URL, or enter a number from this thread's repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              aria-label="Find an issue"
              placeholder="Search issues, #123, or issue URL"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {reference !== null ? (
              <Button disabled={!canLink || pending} onClick={() => void attach(reference)}>
                Link #{reference.number} in {reference.repository}
              </Button>
            ) : null}
            {list.error ? (
              <p role="alert" className="text-xs text-destructive">
                {list.error}
              </p>
            ) : null}
            {!canLink ? (
              <p className="text-xs text-muted-foreground">
                Source control write permission is required to link issues.
              </p>
            ) : null}
            <div className="flex max-h-72 flex-col gap-1 overflow-auto">
              {candidates.map((issue) => (
                <Button
                  key={`${issue.host}/${issue.repository}#${issue.number}`}
                  variant="ghost"
                  disabled={!canLink || pending}
                  onClick={() => void attach(issue)}
                >
                  <IssueGlyph state={issue.state} />
                  <span className="truncate">
                    {issue.repository} #{issue.number} · {issue.title}
                  </span>
                </Button>
              ))}
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {list.isPending
                    ? "Loading issues…"
                    : "No matching unlinked issues. Paste a URL to link an issue outside this list."}
                </p>
              ) : null}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
