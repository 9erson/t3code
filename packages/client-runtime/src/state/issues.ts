import {
  WS_METHODS,
  type EnvironmentId,
  type IssueRef,
  type IssueDetail,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}
export const ISSUE_LIST_MAX_PAGES = 10;

type Target<Input> = { readonly environmentId: EnvironmentId; readonly input: Input };
type IssuePatch = Partial<Pick<IssueDetail, "state" | "labels" | "comments" | "commentCount">>;
/** @public Required for the web client's inferred atom declarations. */
export interface IssueWriteStatus {
  readonly patch: IssuePatch;
  readonly pending: boolean;
  readonly settledAt: number;
  readonly error: string | null;
}
const writeKey = ({ environmentId, input }: Target<IssueRef>) =>
  JSON.stringify([
    environmentId,
    input.projectId,
    input.host.toLowerCase(),
    input.repository.toLowerCase(),
    input.number,
  ]);
const timestamp = <A, E>(result: AsyncResult.AsyncResult<A, E>) =>
  result._tag === "Success"
    ? result.timestamp
    : result._tag === "Failure"
      ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
      : 0;
function applyPatch<A extends IssueListEntry>(
  entry: A,
  status: IssueWriteStatus,
  readAt: number,
): A {
  // A successful revalidation supersedes the write response; a pending read never does.
  return status.pending || readAt <= status.settledAt ? { ...entry, ...status.patch } : entry;
}

export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const refreshes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:issues:refreshes",
    tag: WS_METHODS.issuesSubscribeRefreshes,
  });
  const rawList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:list",
    tag: WS_METHODS.issuesList,
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
  const rawDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
  const detailSource = ({ environmentId, input }: Target<IssueRef>) =>
    rawDetail({
      environmentId,
      input: {
        projectId: input.projectId,
        host: input.host,
        repository: input.repository,
        number: input.number,
      },
    });
  const statuses = Atom.family((_key: string) =>
    Atom.make<IssueWriteStatus>({ patch: {}, pending: false, settledAt: 0, error: null }).pipe(
      Atom.setIdleTTL("5 minutes"),
    ),
  );
  const writeStatus = (target: Target<IssueRef>) => statuses(writeKey(target));
  const detailViews = Atom.family((source: ReturnType<typeof rawDetail>) =>
    Atom.transform(source, (get) => {
      const result = get(source);
      return AsyncResult.map(result, (value) =>
        applyPatch(
          value,
          get(writeStatus({ environmentId: detailTargets.get(source)!, input: value })),
          timestamp(result),
        ),
      );
    }),
  );
  const detailTargets = new WeakMap<ReturnType<typeof rawDetail>, EnvironmentId>();
  const detail = (target: Target<IssueRef>) => {
    const source = detailSource(target);
    detailTargets.set(source, target.environmentId);
    return detailViews(source);
  };
  const listViews = Atom.family((source: ReturnType<typeof rawList>) =>
    Atom.transform(source, (get) => {
      const result = get(source);
      let pending = false;
      const mapped = AsyncResult.map(result, (value) => ({
        ...value,
        entries: value.entries.map((entry) => {
          const status = get(
            writeStatus({ environmentId: listTargets.get(source)!, input: entry }),
          );
          pending ||= status.pending;
          return applyPatch(entry, status, timestamp(result));
        }),
      }));
      // Saved lists must not persist a provisional write that can still roll back.
      return pending ? AsyncResult.waiting(mapped) : mapped;
    }),
  );
  const listTargets = new WeakMap<ReturnType<typeof rawList>, EnvironmentId>();
  const list = (target: Parameters<typeof rawList>[0]) => {
    const source = rawList(target);
    listTargets.set(source, target.environmentId);
    return listViews(source);
  };
  const labelCandidates = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:issues:label-candidates",
    tag: WS_METHODS.issuesLabelCandidates,
  });
  const scheduler = createAtomCommandScheduler();
  function optimistic<Input extends IssueRef, A, F>(
    command: AtomCommand<Target<Input>, A, F>,
    patch: (input: Input, current: IssueDetail | null, now: number) => IssuePatch,
    settle: (patch: IssuePatch, value: A) => IssuePatch,
  ) {
    return {
      ...command,
      run: (registry: Parameters<typeof command.run>[0], target: Target<Input>) =>
        scheduler.schedule(registry, { mode: "serial", key: writeKey }, target, async () => {
          const status = writeStatus(target);
          const previous = registry.get(status);
          const current = Option.getOrNull(AsyncResult.value(registry.get(detail(target))));
          const now = await Effect.runPromise(Clock.currentTimeMillis);
          const raw = registry.get(detailSource(target));
          const previousPatch = timestamp(raw) <= previous.settledAt ? previous.patch : {};
          const optimisticPatch = { ...previousPatch, ...patch(target.input, current, now) };
          registry.set(status, {
            patch: optimisticPatch,
            pending: true,
            settledAt: 0,
            error: null,
          });
          const result = await command.run(registry, target);
          if (AsyncResult.isSuccess(result)) {
            registry.set(status, {
              patch: settle(optimisticPatch, result.value),
              pending: false,
              settledAt: await Effect.runPromise(Clock.currentTimeMillis),
              error: null,
            });
            registry.refresh(detailSource(target));
          } else {
            const failure = Cause.squash(result.cause);
            registry.set(status, {
              ...previous,
              pending: false,
              error:
                failure instanceof Error ? failure.message : "The issue request failed. Try again.",
            });
          }
          return result;
        }),
    };
  }
  const stateCommand = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:issues:set-state",
    tag: WS_METHODS.issuesSetState,
  });
  const labelsCommand = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:issues:set-labels",
    tag: WS_METHODS.issuesSetLabels,
  });
  const commentCommand = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:issues:comment",
    tag: WS_METHODS.issuesComment,
  });
  return {
    refreshes,
    summary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:summary",
      tag: WS_METHODS.issuesSummary,
      staleTimeMs: 30_000,
      refreshIntervalMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:linkedThreads",
      tag: WS_METHODS.issuesLinkedThreads,
      staleTimeMs: 0,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:link",
      tag: WS_METHODS.issuesLink,
    }),
    unlink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:unlink",
      tag: WS_METHODS.issuesUnlink,
    }),
    list,
    detail,
    listPages: Atom.family((key: string) =>
      Atom.make((get) => {
        const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
        const values = new Map<EnvironmentId, IssueListResult>();
        const errors: Cause.Cause<unknown>[] = [];
        let isPending = false;
        for (const target of targets) {
          const result = get(list(target));
          isPending ||= result.waiting || result._tag === "Initial";
          if (result._tag === "Failure") errors.push(result.cause);
          const value = Option.getOrNull(AsyncResult.value(result));
          if (value === null) continue;
          const previous = values.get(target.environmentId);
          values.set(
            target.environmentId,
            previous === undefined ? value : mergeIssueListPages(previous, value),
          );
        }
        return { values: [...values.entries()], errors, isPending };
      }),
    ),
    writeStatus,
    labelCandidates,
    setState: {
      ...stateCommand,
      ...optimistic(
        stateCommand,
        (input) => ({ state: input.state }),
        (patch, state) => ({ ...patch, state }),
      ),
    },
    setLabels: {
      ...labelsCommand,
      ...optimistic(
        labelsCommand,
        (input, current) => ({
          labels: input.labels.map(
            (name) => current?.labels.find((label) => label.name === name) ?? { name, color: null },
          ),
        }),
        (patch, labels) => ({ ...patch, labels }),
      ),
    },
    comment: {
      ...commentCommand,
      ...optimistic(
        commentCommand,
        (input, current, now) => {
          const createdAt = DateTime.formatIso(DateTime.makeUnsafe(now));
          return {
            commentCount: (current?.commentCount ?? 0) + 1,
            comments: [
              ...(current?.comments ?? []),
              {
                id: -1,
                url:
                  current?.url ??
                  `https://${input.host}/${input.repository}/issues/${input.number}`,
                author: null,
                body: input.body,
                createdAt,
                updatedAt: createdAt,
              },
            ],
          };
        },
        (patch, comment) => ({
          ...patch,
          comments: (patch.comments ?? []).map((entry) => (entry.id === -1 ? comment : entry)),
        }),
      ),
    },
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:invalidate",
      tag: WS_METHODS.issuesInvalidate,
    }),
  };
}

/** A continuation replaces cursor state, but retains rows and hosts from exhausted repositories. */
export function mergeIssueListPages(
  previous: IssueListResult,
  next: IssueListResult,
): IssueListResult {
  const entries = new Map(
    previous.entries.map((entry) => [
      `${entry.host.toLowerCase()} ${entry.repository.toLowerCase()} ${entry.number}`,
      entry,
    ]),
  );
  for (const entry of next.entries) {
    const key = `${entry.host.toLowerCase()} ${entry.repository.toLowerCase()} ${entry.number}`;
    const old = entries.get(key);
    if (old === undefined || (entry.observedAt ?? 0) >= (old.observedAt ?? 0))
      entries.set(key, entry);
  }
  const providers = new Map(previous.providers.map((provider) => [provider.host, provider]));
  for (const provider of next.providers) providers.set(provider.host, provider);
  const errors = new Map(previous.errors.map((error) => [error.projectId, error]));
  for (const entry of next.entries) errors.delete(entry.projectId);
  for (const error of next.errors) errors.set(error.projectId, error);
  return {
    ...next,
    viewers: { ...previous.viewers, ...next.viewers },
    entries: [...entries.values()],
    providers: [...providers.values()],
    errors: [...errors.values()],
  };
}

/** Cursor-less environments are exhausted; every continuation keeps the original bounded limit. */
export function issueListNextPage(
  targets: ReadonlyArray<IssueListTarget>,
  values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pagesRead: number,
): ReadonlyArray<IssueListTarget> {
  if (pagesRead >= ISSUE_LIST_MAX_PAGES) return [];
  return targets.flatMap((target) => {
    const result = values.find(([environmentId]) => environmentId === target.environmentId)?.[1];
    if (!result || Object.keys(result.nextCursors).length === 0) return [];
    return [{ ...target, input: { ...target.input, cursors: result.nextCursors } }];
  });
}
