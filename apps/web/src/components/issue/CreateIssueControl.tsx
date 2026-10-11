import { useAtomValue } from "@effect/atom-react";
import type { IssueActor, IssueLabel, IssueListEntry } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Result from "effect/Result";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  initialIssueComposerState,
  issueComposerReducer,
  prepareIssueCreate,
  type IssueCreationTarget,
} from "./issueComposer.logic";

const denied = Atom.make(false);

export function CreateIssueControl(props: {
  targets: ReadonlyArray<IssueCreationTarget>;
  preferredKey?: string | undefined;
  onCreated: (target: IssueCreationTarget, issue: IssueListEntry) => void;
}) {
  return <IssueComposer {...props} />;
}

function IssueComposer({
  targets,
  preferredKey,
  onCreated,
}: {
  targets: ReadonlyArray<IssueCreationTarget>;
  preferredKey?: string | undefined;
  onCreated: (target: IssueCreationTarget, issue: IssueListEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetKey, setTargetKey] = useState<string | null>(
    preferredKey ?? targets[0]?.key ?? null,
  );
  const target =
    targets.find((target) => target.key === targetKey) ??
    (targetKey === null ? (targets[0] ?? null) : null);
  const canCreate = useAtomValue(
    target ? issueEnvironment.create.permissionAtom(target.environmentId) : denied,
  );
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const [state, dispatch] = useReducer(issueComposerReducer, initialIssueComposerState);
  const { draft, pending, error } = state;
  const submit = async () => {
    if (!target || !canCreate || pending) return;
    const input = prepareIssueCreate(target, draft);
    if (Result.isFailure(input)) {
      dispatch({ type: "failure", error: input.failure.message });
      return;
    }
    dispatch({ type: "submit" });
    const result = await create({ environmentId: target.environmentId, input: input.success });
    if (result._tag === "Failure") {
      dispatch({ type: "failure", error: formatEnvironmentQueryError(result.cause) });
      return;
    }
    dispatch({ type: "success" });
    setOpen(false);
    onCreated(target, result.value);
  };
  return (
    <>
      <Button
        size="sm"
        disabled={targets.length === 0}
        onClick={() => {
          if (
            !draft.title &&
            !draft.body &&
            draft.labels.length === 0 &&
            draft.assignees.length === 0
          )
            setTargetKey(preferredKey ?? targets[0]?.key ?? null);
          setOpen(true);
        }}
      >
        <PlusIcon /> Create new issue
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogPopup showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Create new issue</DialogTitle>
            <DialogDescription>
              File an issue in a project's GitHub repository. Your draft stays here until it is
              filed or you discard it.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="flex min-h-0 flex-1 flex-col"
            aria-busy={pending}
          >
            <DialogPanel>
              <div className="space-y-1.5">
                <label id="issue-project-label" className="text-sm font-medium">
                  Project
                </label>
                <Select
                  value={target?.key ?? null}
                  disabled={pending}
                  items={targets.map((target) => ({
                    value: target.key,
                    label: `${target.title} · ${target.host}/${target.repository}`,
                  }))}
                  onValueChange={(key) => {
                    if (key === null || key === target?.key) return;
                    setTargetKey(key);
                    dispatch({ type: "edit", patch: { labels: [], assignees: [] } });
                  }}
                >
                  <SelectTrigger aria-labelledby="issue-project-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map((target) => (
                      <SelectItem key={target.key} value={target.key}>
                        {target.title} · {target.host}/{target.repository}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-issue-title" className="text-sm font-medium">
                  Title
                </label>
                <Input
                  id="new-issue-title"
                  value={draft.title}
                  maxLength={256}
                  disabled={pending}
                  placeholder="Issue title"
                  onChange={(event) =>
                    dispatch({ type: "edit", patch: { title: event.target.value } })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-issue-body" className="text-sm font-medium">
                  Description <span className="font-normal text-muted-foreground">(Markdown)</span>
                </label>
                <Textarea
                  id="new-issue-body"
                  size="lg"
                  value={draft.body}
                  maxLength={65536}
                  disabled={pending}
                  placeholder="Describe the issue…"
                  onChange={(event) =>
                    dispatch({ type: "edit", patch: { body: event.target.value } })
                  }
                />
              </div>
              {target ? (
                <RepositoryPickers
                  key={`${target.key}:${target.host}:${target.repository}`}
                  target={target}
                  open={open}
                  disabled={pending}
                  labels={draft.labels}
                  assignees={draft.assignees}
                  onLabels={(labels) => dispatch({ type: "edit", patch: { labels } })}
                  onAssignees={(assignees) => dispatch({ type: "edit", patch: { assignees } })}
                />
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Select an available GitHub project to continue. Your draft has been kept.
                </p>
              )}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error} Your draft has been kept.
                </p>
              ) : null}
              {!canCreate ? (
                <p role="status" className="text-sm text-muted-foreground">
                  This connection needs source control write permission to file issues in this
                  project.
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  dispatch({ type: "success" });
                  setOpen(false);
                }}
              >
                Discard draft
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Keep draft
              </Button>
              <Button type="submit" disabled={!canCreate || pending}>
                {pending ? "Creating issue…" : "Create issue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function RepositoryPickers({
  target,
  open,
  disabled,
  labels,
  assignees,
  onLabels,
  onAssignees,
}: {
  target: IssueCreationTarget;
  open: boolean;
  disabled: boolean;
  labels: ReadonlyArray<string>;
  assignees: ReadonlyArray<string>;
  onLabels: (labels: ReadonlyArray<string>) => void;
  onAssignees: (assignees: ReadonlyArray<string>) => void;
}) {
  const canReadLabels = useAtomValue(
    issueEnvironment.labelCandidates.permissionAtom(target.environmentId),
  );
  const canReadAssignees = useAtomValue(
    issueEnvironment.assigneeCandidates.permissionAtom(target.environmentId),
  );
  const labelCandidates = useAtomCommand(issueEnvironment.labelCandidates, {
    reportFailure: false,
  });
  const assigneeCandidates = useAtomCommand(issueEnvironment.assigneeCandidates, {
    reportFailure: false,
  });
  const [labelResult, setLabelResult] = useState<{
    key: string;
    options: ReadonlyArray<IssueLabel> | null;
    error: string | null;
  } | null>(null);
  const [assigneeResult, setAssigneeResult] = useState<{
    key: string;
    options: ReadonlyArray<IssueActor> | null;
    error: string | null;
  } | null>(null);
  const [labelReload, reloadLabels] = useReducer((n: number) => n + 1, 0);
  const [assigneeReload, reloadAssignees] = useReducer((n: number) => n + 1, 0);
  const { environmentId, projectId, host, repository } = target;
  const labelKey = `${open}:${labelReload}`;
  const assigneeKey = `${open}:${assigneeReload}`;
  const labelOptions = labelResult?.key === labelKey ? labelResult.options : null;
  const labelError = labelResult?.key === labelKey ? labelResult.error : null;
  const assigneeOptions = assigneeResult?.key === assigneeKey ? assigneeResult.options : null;
  const assigneeError = assigneeResult?.key === assigneeKey ? assigneeResult.error : null;
  useEffect(() => {
    if (!open || !canReadLabels) return;
    let active = true;

    void labelCandidates({ environmentId, input: { projectId, host, repository } }).then(
      (result) => {
        if (!active) return;
        setLabelResult({
          key: labelKey,
          options: result._tag === "Success" ? result.value : null,
          error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [open, canReadLabels, environmentId, projectId, host, repository, labelKey, labelCandidates]);
  useEffect(() => {
    if (!open || !canReadAssignees) return;
    let active = true;

    void assigneeCandidates({ environmentId, input: { projectId, host, repository } }).then(
      (result) => {
        if (!active) return;
        setAssigneeResult({
          key: assigneeKey,
          options: result._tag === "Success" ? result.value : null,
          error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [
    open,
    canReadAssignees,
    environmentId,
    projectId,
    host,
    repository,
    assigneeKey,
    assigneeCandidates,
  ]);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <CandidatePicker
        title="Labels"
        options={
          labelOptions?.map((label) => ({
            value: label.name,
            content: <PullRequestLabelChip label={label} />,
          })) ?? null
        }
        selected={labels}
        disabled={disabled || !canReadLabels}
        error={labelError}
        onReload={reloadLabels}
        onChange={onLabels}
        limit={100}
      />
      <CandidatePicker
        title="Assignees"
        options={
          assigneeOptions?.map((actor) => ({
            value: actor.login,
            content: actor.name ? `${actor.login} (${actor.name})` : actor.login,
          })) ?? null
        }
        selected={assignees}
        disabled={disabled || !canReadAssignees}
        error={assigneeError}
        onReload={reloadAssignees}
        onChange={onAssignees}
        limit={10}
      />
    </div>
  );
}

function CandidatePicker({
  title,
  options,
  selected,
  disabled,
  error,
  onReload,
  onChange,
  limit,
}: {
  title: string;
  options: ReadonlyArray<{ value: string; content: ReactNode }> | null;
  selected: ReadonlyArray<string>;
  disabled: boolean;
  error: string | null;
  onReload: () => void;
  onChange: (values: ReadonlyArray<string>) => void;
  limit: number;
}) {
  const [query, setQuery] = useState("");
  const matches = options?.filter((option) =>
    option.value.toLowerCase().includes(query.toLowerCase()),
  );
  const visible = matches?.slice(0, 100);
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">
        {title}
        {selected.length ? ` (${selected.length})` : ""}
      </legend>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              aria-label={`Remove ${value}`}
              onClick={() => onChange(selected.filter((entry) => entry !== value))}
            >
              <span className="max-w-40 truncate">{value}</span>
              <XIcon />
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="search"
          aria-label={`Search ${title.toLowerCase()}`}
          placeholder={`Search ${title.toLowerCase()}…`}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onReload}
          aria-label={`Reload ${title.toLowerCase()}`}
        >
          Reload
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : options === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          {disabled
            ? "Permission is required to load candidates."
            : `Loading ${title.toLowerCase()}…`}
        </p>
      ) : null}
      <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-2">
        {visible?.map((option) => (
          <label key={option.value} className="flex min-w-0 items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(option.value)}
              disabled={disabled || (!selected.includes(option.value) && selected.length >= limit)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value),
                )
              }
            />
            <span className="min-w-0 truncate">{option.content}</span>
          </label>
        ))}
        {visible?.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {options?.length === 0
              ? `No ${title.toLowerCase()} are available in this repository.`
              : "No matches."}
          </p>
        ) : null}
      </div>
      {(matches?.length ?? 0) > 100 ? (
        <p className="text-xs text-muted-foreground">
          Showing the first 100 matches. Narrow your search to find more.
        </p>
      ) : null}
    </fieldset>
  );
}
