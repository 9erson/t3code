import { useAtomValue } from "@effect/atom-react";
import type { IssueDetail, IssueLabel } from "@t3tools/contracts";
import { useState } from "react";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import type { IssueSelection } from "./issueSelection.logic";

export function IssueDetailActions({
  selection,
  detail,
}: {
  selection: IssueSelection;
  detail: IssueDetail;
}) {
  const { environmentId, projectId, host, repository, number } = selection;
  const target = { environmentId, input: { projectId, host, repository, number } };
  const status = useAtomValue(issueEnvironment.writeStatus(target));
  const canComment = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const canSetState = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const canSetLabels = useAtomValue(issueEnvironment.setLabels.permissionAtom(environmentId));
  const canReadLabels = useAtomValue(
    issueEnvironment.labelCandidates.permissionAtom(environmentId),
  );
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const setLabels = useAtomCommand(issueEnvironment.setLabels, { reportFailure: false });
  const labelCandidates = useAtomCommand(issueEnvironment.labelCandidates, {
    reportFailure: false,
  });
  const [body, setBody] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [candidates, setCandidates] = useState<ReadonlyArray<IssueLabel> | null>(null);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const loadLabels = async () => {
    setLabelsLoading(true);
    setLabelsError(null);
    try {
      const result = await labelCandidates({
        environmentId,
        input: { projectId, host, repository },
      });
      if (result._tag === "Success") setCandidates(result.value);
      else setLabelsError(formatEnvironmentQueryError(result.cause));
    } finally {
      setLabelsLoading(false);
    }
  };
  return (
    <section aria-label="Issue actions" className="space-y-4 border-t pt-4">
      {status.error ? (
        <p role="alert" className="text-sm text-destructive">
          {status.error} Your change was rolled back.
        </p>
      ) : null}
      {status.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Saving issue changes…
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!canSetState || status.pending}
          onClick={() =>
            void setState({
              ...target,
              input: { ...target.input, state: detail.state === "open" ? "closed" : "open" },
            })
          }
        >
          {detail.state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={labelsOpen}
          disabled={!canSetLabels || !canReadLabels || status.pending}
          onClick={() => {
            setLabelsOpen(!labelsOpen);
            if (!labelsOpen) void loadLabels();
          }}
        >
          Edit labels
        </Button>
      </div>
      {labelsOpen ? (
        <div aria-label="Repository labels" className="space-y-2 rounded-md border p-3">
          {labelsLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading labels…
            </p>
          ) : labelsError ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {labelsError}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!canReadLabels}
                onClick={() => void loadLabels()}
              >
                Retry labels
              </Button>
            </div>
          ) : candidates?.length === 0 ? (
            <p className="text-sm text-muted-foreground">This repository has no labels.</p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {candidates?.map((label) => {
                const applied = detail.labels.some((current) => current.name === label.name);
                return (
                  <label key={label.name} className="flex items-center gap-2">
                    <Checkbox
                      checked={applied}
                      disabled={!canSetLabels || status.pending}
                      onCheckedChange={(checked) =>
                        void setLabels({
                          ...target,
                          input: {
                            ...target.input,
                            labels: checked
                              ? [...detail.labels.map((current) => current.name), label.name]
                              : detail.labels
                                  .filter((current) => current.name !== label.name)
                                  .map((current) => current.name),
                          },
                        })
                      }
                    />
                    <PullRequestLabelChip label={label} />
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const submitted = body.trim();
          if (!canComment || status.pending || !submitted) return;
          void comment({ ...target, input: { ...target.input, body: submitted } }).then(
            (result) => {
              if (result._tag === "Success") setBody("");
            },
          );
        }}
      >
        <Textarea
          aria-label="Write a comment"
          placeholder="Write a comment…"
          value={body}
          maxLength={65536}
          disabled={!canComment || status.pending}
          onChange={(event) => setBody(event.target.value)}
        />
        <Button
          variant="default"
          size="sm"
          type="submit"
          disabled={!canComment || status.pending || !body.trim()}
        >
          Comment
        </Button>
        {!canComment && !canSetState && !canSetLabels ? (
          <p className="text-xs text-muted-foreground">
            This connection does not have permission to write issues.
          </p>
        ) : null}
      </form>
    </section>
  );
}
