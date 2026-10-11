import {
  IssueOperationError,
  IssueCreateInput,
  type IssueActor,
  type IssueAssigneeCandidatesInput,
  type IssueComment,
  type IssueCommentInput,
  type IssueLabel,
  type IssueLabelCandidatesInput,
  type IssueSetLabelsInput,
  type IssueSetStateInput,
  type IssueState,
  IssueRef,
  type IssueDetail,
  type IssueListInput,
  type IssueListResult,
  type IssueListEntry,
  ThreadIssueKey,
  normalizeThreadIssueKey,
  type SourceControlProviderKind,
  pullRequestHostOf,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueReadCache from "./IssueReadCache.ts";
import * as IssueProviderRegistry from "./IssueProviderRegistry.ts";

const decodeCreate = Schema.decodeEffect(IssueCreateInput);
const detailKeyCodec = Schema.fromJsonString(IssueRef);
const encodeDetailKey = Schema.encodeSync(detailKeyCodec);
const decodeDetailKey = Schema.decodeSync(detailKeyCodec);

const summaryKey = Schema.fromJsonString(Schema.Tuple([Schema.Number, ThreadIssueKey]));
const encodeSummaryKey = Schema.encodeSync(summaryKey);
const decodeSummaryKey = Schema.decodeSync(summaryKey);

const isIssueOperationError = Schema.is(IssueOperationError);

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly create: (
      input: IssueCreateInput,
    ) => Effect.Effect<IssueListEntry, IssueOperationError>;
    readonly assigneeCandidates: (
      input: IssueAssigneeCandidatesInput,
    ) => Effect.Effect<ReadonlyArray<IssueActor>, IssueOperationError>;
    readonly labelCandidates: (
      input: IssueLabelCandidatesInput,
    ) => Effect.Effect<ReadonlyArray<IssueLabel>, IssueOperationError>;
    readonly setState: (
      input: IssueSetStateInput,
    ) => Effect.Effect<IssueState, IssueOperationError>;
    readonly setLabels: (
      input: IssueSetLabelsInput,
    ) => Effect.Effect<ReadonlyArray<IssueLabel>, IssueOperationError>;
    readonly comment: (
      input: IssueCommentInput,
    ) => Effect.Effect<IssueComment, IssueOperationError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueOperationError>;
    readonly summary: (
      input: ThreadIssueKey,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<IssueListEntry, IssueOperationError>;
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueOperationError>;
    readonly invalidate: () => Effect.Effect<void>;
    readonly subscribeRefreshes: Stream.Stream<number>;
  }
>()("t3/issue/IssueService") {}

/** Public construction allows service-boundary tests to supply external ports. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const readCache = yield* IssueReadCache.IssueReadCache;
  const registry = yield* IssueProviderRegistry.IssueProviderRegistry;
  const refreshes = yield* SubscriptionRef.make(0);
  let epoch = 0;
  const listUncached = Effect.fn("IssueService.list")(function* (input: IssueListInput) {
    const rows = yield* (
      input.projectId === undefined
        ? projects.listShells(
            input.projectIds === undefined ? undefined : { projectIds: input.projectIds },
          )
        : projects.getShell(input.projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError((cause) => new IssueOperationError({ host: "", reason: "transient", cause })),
    );
    const resolved = yield* Effect.forEach(
      rows,
      (project) =>
        (project.repositoryIdentity == null || project.repositoryIdentity.provider === "unknown"
          ? identities
              .resolve(project.workspaceRoot)
              .pipe(Effect.map((identity) => identity ?? project.repositoryIdentity ?? null))
          : Effect.succeed(project.repositoryIdentity)
        ).pipe(Effect.map((identity) => ({ project, identity }))),
      { concurrency: 6 },
    );
    const hosts = new Map<
      string,
      {
        kind: SourceControlProviderKind;
        projects: Array<{ project: (typeof rows)[number]; repository: string }>;
      }
    >();
    const seen = new Set<string>();
    for (const { project, identity } of resolved) {
      if (input.projectIds !== undefined && !input.projectIds.includes(project.id)) continue;
      const repository = sourceControlRepositorySelector(identity);
      if (identity == null || repository === null) continue;
      const kind = (identity.provider ?? "unknown") as SourceControlProviderKind;
      const host = pullRequestHostOf(identity, kind);
      if (input.host !== undefined && input.host.toLowerCase() !== host) continue;
      const key = `${host} ${repository.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let bucket = hosts.get(host);
      if (bucket === undefined) {
        bucket = { kind, projects: [] };
        hosts.set(host, bucket);
      }
      bucket.projects.push({ project, repository });
    }
    const result: { -readonly [K in keyof IssueListResult]: IssueListResult[K] } = {
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: false,
      nextCursors: {},
    };
    const answers = yield* Effect.forEach(
      hosts,
      Effect.fnUntraced(function* ([host, bucket]) {
        const api = registry.get(bucket.kind);
        if (api === null)
          return {
            host,
            bucket,
            error: new IssueOperationError({ host, reason: "provider-unsupported" }),
            viewer: null,
            pages: [],
          };
        const viewer = yield* api
          .getViewer({ host, cwd: bucket.projects[0]!.project.workspaceRoot })
          .pipe(Effect.result);
        if (Result.isFailure(viewer))
          return { host, bucket, error: viewer.failure, viewer: null, pages: [] };
        const pages = yield* Effect.forEach(
          bucket.projects.filter(
            ({ repository }) =>
              input.cursors === undefined ||
              input.cursors[`${host} ${repository.toLowerCase()}`] !== undefined,
          ),
          Effect.fnUntraced(function* ({ project, repository }) {
            const observedAt = yield* Clock.currentTimeMillis;
            const cursor = input.cursors?.[`${host} ${repository.toLowerCase()}`];
            const page = yield* api
              .listIssues({
                host,
                cwd: project.workspaceRoot,
                repository,
                state: input.state,
                ...(input.query === undefined ? {} : { query: input.query }),
                ...(input.filters === undefined ? {} : { filters: input.filters }),
                ...(input.sort === undefined ? {} : { sort: input.sort }),
                limit: input.limit ?? 100,
                ...(cursor === undefined ? {} : { cursor }),
              })
              .pipe(Effect.result);
            return { project, repository, observedAt, page };
          }),
          { concurrency: 4 },
        );
        return { host, bucket, viewer: viewer.success, error: null, pages };
      }),
      { concurrency: 4 },
    );
    const failures: IssueOperationError[] = [];
    let readable = false;
    for (const answer of answers) {
      const { host, bucket, viewer, error, pages } = answer;
      const pageFailure = pages.find(({ page }) => Result.isFailure(page))?.page;
      const hostError =
        error ??
        (pageFailure !== undefined && Result.isFailure(pageFailure) ? pageFailure.failure : null);
      result.providers = [
        ...result.providers,
        {
          host,
          kind: bucket.kind,
          projectCount: bucket.projects.length,
          configured: hostError === null,
          detail: hostError?.message ?? null,
        },
      ];
      if (viewer !== null) result.viewers = { ...result.viewers, [host]: viewer };
      if (error !== null) {
        if (error.reason !== "provider-unsupported") {
          failures.push(error);
          for (const { repository } of bucket.projects) {
            const key = `${host} ${repository.toLowerCase()}`;
            if (input.cursors === undefined || input.cursors[key] !== undefined) {
              result.truncated = true;
              result.nextCursors = { ...result.nextCursors, [key]: input.cursors?.[key] ?? "1:0" };
            }
          }
          result.errors = [
            ...result.errors,
            ...bucket.projects.map(({ project }) => ({
              projectId: project.id,
              projectTitle: project.title,
              message: error.message,
            })),
          ];
        }
        continue;
      }
      if (pages.length === 0) readable = true;
      for (const { project, repository, observedAt, page } of pages) {
        if (Result.isFailure(page)) {
          failures.push(page.failure);
          result.truncated = true;
          const key = `${host} ${repository.toLowerCase()}`;
          result.nextCursors = { ...result.nextCursors, [key]: input.cursors?.[key] ?? "1:0" };
          result.errors = [
            ...result.errors,
            { projectId: project.id, projectTitle: project.title, message: page.failure.message },
          ];
          continue;
        }
        readable = true;
        result.entries = [
          ...result.entries,
          ...page.success.items.map((item) => ({
            ...item,
            provider: bucket.kind,
            host,
            projectId: project.id,
            projectTitle: project.title,
            repository,
            observedAt,
          })),
        ];
        if (page.success.nextCursor !== null) {
          result.truncated = true;
          result.nextCursors = {
            ...result.nextCursors,
            [`${host} ${repository.toLowerCase()}`]: page.success.nextCursor,
          };
        }
      }
    }
    if (!readable && failures.length > 0)
      return yield* (
        failures.find(
          (error) =>
            error.reason === "credentials-missing" ||
            error.reason === "auth-disabled" ||
            error.reason === "authentication",
        ) ?? failures[0]!
      );
    result.entries = result.entries.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return result;
  });
  const cache = yield* Cache.makeWith(
    (key: string) =>
      readCache.get(
        JSON.stringify(JSON.parse(key).input),
        listUncached(JSON.parse(key).input as IssueListInput),
      ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero),
    },
  );
  const resolve = Effect.fn("IssueService.resolve")(function* (
    input: Pick<IssueRef, "projectId" | "host" | "repository">,
  ) {
    const shell = yield* projects
      .getShell(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new IssueOperationError({ host: input.host, reason: "transient", cause }),
        ),
      );
    if (Option.isNone(shell))
      return yield* new IssueOperationError({ host: input.host, reason: "not-found" });
    const project = shell.value;
    const identity =
      project.repositoryIdentity == null || project.repositoryIdentity.provider === "unknown"
        ? yield* identities.resolve(project.workspaceRoot)
        : project.repositoryIdentity;
    const repository = sourceControlRepositorySelector(identity);
    const kind = (identity?.provider ?? "unknown") as SourceControlProviderKind;
    const host = pullRequestHostOf(identity, kind);
    if (
      repository === null ||
      repository.toLowerCase() !== input.repository.toLowerCase() ||
      host !== input.host.toLowerCase()
    )
      return yield* new IssueOperationError({ host: input.host, reason: "not-found" });
    const api = registry.get(kind);
    if (api === null)
      return yield* new IssueOperationError({ host, reason: "provider-unsupported" });
    return { project, api, host, repository, kind };
  });
  const summary = Effect.fn("IssueService.summary")(
    function* (input: ThreadIssueKey) {
      const key = normalizeThreadIssueKey(input);
      const rows = yield* projects.listShells();
      for (const project of rows) {
        const identity =
          project.repositoryIdentity == null || project.repositoryIdentity.provider === "unknown"
            ? ((yield* identities.resolve(project.workspaceRoot)) ??
              project.repositoryIdentity ??
              null)
            : project.repositoryIdentity;
        const repository = sourceControlRepositorySelector(identity);
        if (
          identity == null ||
          repository?.toLowerCase() !== key.repository ||
          pullRequestHostOf(identity, "github") !== key.host
        )
          continue;
        if (identity.provider !== "github")
          return yield* new IssueOperationError({ host: key.host, reason: "provider-unsupported" });
        const provider = registry.get("github");
        if (provider === null)
          return yield* new IssueOperationError({ host: key.host, reason: "provider-unsupported" });
        const issue = yield* provider.getIssueSummary({ ...key, cwd: project.workspaceRoot });
        return {
          ...issue,
          ...key,
          provider: "github" as const,
          projectId: project.id,
          projectTitle: project.title,
        };
      }
      return yield* new IssueOperationError({ host: key.host, reason: "repository-unavailable" });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isIssueOperationError(cause)
            ? cause
            : new IssueOperationError({ host: input.host, reason: "transient", cause }),
        ),
      ),
  );

  const summaries = yield* Cache.makeWith((key: string) => summary(decodeSummaryKey(key)[1]), {
    capacity: 128,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero),
  });
  const details = yield* Cache.makeWith(
    Effect.fn("IssueService.detail")(function* (key: string) {
      const input = decodeDetailKey(key);
      const { project, api, host, repository, kind } = yield* resolve(input);
      const detail = yield* api.getIssue({
        host,
        repository,
        number: input.number,
        cwd: project.workspaceRoot,
      });
      return {
        ...detail,
        provider: kind,
        host,
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository,
        observedAt: yield* Clock.currentTimeMillis,
      };
    }),
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(60) : Duration.zero),
    },
  );
  const invalidate = Effect.fn("IssueService.invalidate")(function* () {
    // Finish clearing persisted reads before publishing a new memory-cache epoch.
    yield* readCache.invalidate;
    epoch += 1;
    yield* Cache.invalidateAll(cache);
    yield* Cache.invalidateAll(summaries);
    yield* Cache.invalidateAll(details);
    yield* SubscriptionRef.update(refreshes, (value) => value + 1);
  });
  return IssueService.of({
    create: Effect.fn("IssueService.create")(function* (draft) {
      const input = yield* decodeCreate(draft).pipe(
        Effect.mapError(
          (cause) => new IssueOperationError({ host: draft.host, reason: "invalid-input", cause }),
        ),
      );
      const { api, project, host, repository, kind } = yield* resolve(input);
      const issue = yield* api.create({ ...input, host, repository, cwd: project.workspaceRoot });
      yield* invalidate();
      return {
        ...issue,
        host,
        repository,
        provider: kind,
        projectId: project.id,
        projectTitle: project.title,
        observedAt: yield* Clock.currentTimeMillis,
      };
    }),
    assigneeCandidates: Effect.fn("IssueService.assigneeCandidates")(function* (input) {
      const { api, project, host, repository } = yield* resolve(input);
      return yield* api.assigneeCandidates({ host, repository, cwd: project.workspaceRoot });
    }),
    labelCandidates: Effect.fn("IssueService.labelCandidates")(function* (input) {
      const { api, project, host, repository } = yield* resolve(input);
      return yield* api.labelCandidates({ host, repository, cwd: project.workspaceRoot });
    }),
    setState: Effect.fn("IssueService.setState")(function* (input) {
      const { api, project, host, repository } = yield* resolve(input);
      const state = yield* api.setState({ ...input, host, repository, cwd: project.workspaceRoot });
      yield* invalidate();
      return state;
    }),
    setLabels: Effect.fn("IssueService.setLabels")(function* (input) {
      const { api, project, host, repository } = yield* resolve(input);
      const labels = yield* api.setLabels({
        ...input,
        host,
        repository,
        cwd: project.workspaceRoot,
      });
      yield* invalidate();
      return labels;
    }),
    comment: Effect.fn("IssueService.comment")(function* (input) {
      const { api, project, host, repository } = yield* resolve(input);
      const comment = yield* api.comment({
        ...input,
        host,
        repository,
        cwd: project.workspaceRoot,
      });
      yield* invalidate();
      return comment;
    }),
    detail: (input) =>
      Cache.get(
        details,
        encodeDetailKey({
          projectId: input.projectId,
          host: input.host.toLowerCase(),
          repository: input.repository.toLowerCase(),
          number: input.number,
        }),
      ),

    summary: (input, options) =>
      options?.fresh === true
        ? summary(input)
        : Cache.get(summaries, encodeSummaryKey([epoch, normalizeThreadIssueKey(input)])),
    list: (input) =>
      Cache.get(
        cache,
        JSON.stringify({
          epoch,
          input: {
            state: input.state,
            query: input.query?.trim(),
            filters: input.filters,
            sort: input.sort,
            projectId: input.projectId,
            projectIds: input.projectIds?.toSorted(),
            host: input.host?.toLowerCase(),
            limit: input.limit,
            cursors:
              input.cursors === undefined
                ? undefined
                : Object.fromEntries(Object.entries(input.cursors).toSorted()),
          },
        }),
      ),
    invalidate,
    subscribeRefreshes: SubscriptionRef.changes(refreshes),
  });
});
export const layer = Layer.effect(IssueService, make);
