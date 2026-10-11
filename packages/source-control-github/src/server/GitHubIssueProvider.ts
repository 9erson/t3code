import {
  IssueOperationError,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type {
  IssueProviderApi,
  ProviderIssue,
  ProviderIssueDetail,
} from "@t3tools/source-control-core/server/IssueProvider";
import { parseIssueSearch } from "@t3tools/shared/issueSearch";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitHubApi from "./GitHubApi.ts";

const Actor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const Label = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const label = (value: typeof Label.Type) => ({ name: value.name, color: value.color ?? null });
const Row = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  user: Schema.NullOr(Actor),
  state: Schema.Literals(["open", "closed"]),
  labels: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      color: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  assignees: Schema.Array(Actor),
  comments: NonNegativeInt,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  pull_request: Schema.optional(Schema.Unknown),
});
const DetailRow = Schema.Struct({ ...Row.fields, body: Schema.NullOr(Schema.String) });
const Comment = Schema.Struct({
  id: PositiveInt,
  html_url: TrimmedNonEmptyString,
  user: Schema.NullOr(Actor),
  body: Schema.NullOr(Schema.String),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
const actor = (value: typeof Actor.Type) => ({
  login: value.login,
  name: null,
  avatarUrl: value.avatar_url ?? null,
});
const failure = (error: GitHubApi.GitHubApiError) =>
  new IssueOperationError({
    host: error.host,
    reason:
      error._tag === "GitHubCliMissingError" || error._tag === "GitHubNotSignedInError"
        ? "credentials-missing"
        : error._tag === "GitHubHostDisabledError"
          ? "auth-disabled"
          : error._tag === "GitHubApiAuthenticationError"
            ? "authentication"
            : error._tag === "GitHubApiRateLimitError" ||
                error._tag === "SourceControlRateLimitPausedError"
              ? "rate-limited"
              : error._tag === "GitHubApiNotFoundError"
                ? "not-found"
                : "transient",
    ...("retryAt" in error && error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
    cause: error,
  });

const toIssue = (row: typeof Row.Type): ProviderIssue => ({
  number: row.number,
  title: row.title,
  url: row.html_url,
  author: row.user === null ? null : actor(row.user),
  state: row.state,
  labels: row.labels.map((label) => ({ name: label.name, color: label.color ?? null })),
  assignees: row.assignees.map(actor),
  commentCount: row.comments,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const read = <S extends Schema.Top>(
    host: string,
    path: string,
    schema: S,
    operation = "listIssues",
    request: Pick<GitHubApi.GitHubRestInput, "method" | "body"> = {},
  ) => {
    const search = path.startsWith("search/");
    return api
      .rest({ host, path, operation: search ? "searchIssues" : operation, ...request })
      .pipe(
        Effect.mapError((error) => {
          const mapped = failure(error);
          return new IssueOperationError({
            host,
            reason:
              search && error._tag === "GitHubApiResponseError" && error.status === 422
                ? "invalid-query"
                : mapped.reason,
            ...(mapped.retryAt === undefined ? {} : { retryAt: mapped.retryAt }),
            ...(mapped.reason === "rate-limited"
              ? { rateLimitResource: search ? ("search" as const) : ("core" as const) }
              : {}),
            cause: error,
          });
        }),
        Effect.flatMap((response) =>
          response.truncated || response.invalidUtf8
            ? Effect.fail(new IssueOperationError({ host, reason: "invalid-response" }))
            : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
                Effect.mapError(
                  (cause) => new IssueOperationError({ host, reason: "invalid-response", cause }),
                ),
                Effect.map((value) => ({ value, headers: response.headers })),
              ),
        ),
      );
  };
  const viewers = yield* Cache.makeWith(
    (key: string) => {
      const [host] = JSON.parse(key) as [string, string];
      return read(host, "user", Actor).pipe(Effect.map(({ value }) => value.login));
    },
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero),
    },
  );
  const provider: IssueProviderApi = {
    kind: "github",
    labelCandidates: Effect.fn("GitHubIssueProvider.labelCandidates")(function* (input) {
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const labels: Array<ReturnType<typeof label>> = [];
      for (let page = 1; page <= 10; page += 1) {
        const { value, headers } = yield* read(
          input.host,
          `repos/${repository}/labels?per_page=100&page=${page}`,
          Schema.Array(Label),
          "issueLabelCandidates",
        );
        labels.push(...value.map(label));
        if (!headers.link?.includes('rel="next"')) return labels;
      }
      return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
    }),
    setLabels: Effect.fn("GitHubIssueProvider.setLabels")(function* (input) {
      const candidates = yield* provider.labelCandidates(input);
      const labels: string[] = [];
      for (const name of input.labels) {
        const existing = candidates.find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing === undefined)
          return yield* new IssueOperationError({ host: input.host, reason: "label-not-found" });
        if (!labels.includes(existing.name)) labels.push(existing.name);
      }
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const { value } = yield* read(
        input.host,
        `repos/${repository}/issues/${input.number}/labels`,
        Schema.Array(Label),
        "issueSetLabels",
        { method: "PUT", body: { labels } },
      );
      return value.map(label);
    }),
    setState: Effect.fn("GitHubIssueProvider.setState")(function* (input) {
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const { value } = yield* read(
        input.host,
        `repos/${repository}/issues/${input.number}`,
        Row,
        "issueSetState",
        {
          method: "PATCH",
          body: { state: input.state },
        },
      );
      if (value.pull_request !== undefined)
        return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
      return value.state;
    }),
    comment: Effect.fn("GitHubIssueProvider.comment")(function* (input) {
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const { value } = yield* read(
        input.host,
        `repos/${repository}/issues/${input.number}/comments`,
        Comment,
        "issueComment",
        {
          method: "POST",
          body: { body: input.body },
        },
      );
      return {
        id: value.id,
        url: value.html_url,
        author: value.user === null ? null : actor(value.user),
        body: value.body ?? "",
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      };
    }),
    getIssue: Effect.fn("GitHubIssueProvider.getIssue")(function* (input) {
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const path = `repos/${repository}/issues/${input.number}`;
      const { value: row } = yield* read(input.host, path, DetailRow, "issueDetail");
      if (row.pull_request !== undefined)
        return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
      const comments: Array<ProviderIssueDetail["comments"][number]> = [];
      let more = false;
      // Keep the read bounded; never present a partial timeline as complete.
      for (let page = 1; page <= 10; page += 1) {
        const { value, headers } = yield* read(
          input.host,
          `${path}/comments?per_page=100&page=${page}`,
          Schema.Array(Comment),
          "issueComments",
        );
        comments.push(
          ...value.map((comment) => ({
            id: comment.id,
            url: comment.html_url,
            author: comment.user === null ? null : actor(comment.user),
            body: comment.body ?? "",
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
          })),
        );
        more = /rel="next"/.test(headers.link ?? "");
        if (!more) break;
      }
      return {
        number: row.number,
        title: row.title,
        url: row.html_url,
        author: row.user === null ? null : actor(row.user),
        state: row.state,
        labels: row.labels.map((label) => ({ name: label.name, color: label.color ?? null })),
        assignees: row.assignees.map(actor),
        commentCount: row.comments,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        body: row.body ?? "",
        comments,
        commentsTruncated: more,
      };
    }),
    getViewer: ({ host }) =>
      api.credential(host).pipe(
        Effect.mapError(failure),
        Effect.flatMap(({ fingerprint }) =>
          Cache.get(viewers, JSON.stringify([host, fingerprint])),
        ),
      ),
    getIssueSummary: Effect.fn("GitHubIssueProvider.getIssueSummary")(function* (input) {
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const { value } = yield* read(
        input.host,
        `repos/${repository}/issues/${input.number}`,
        Row,
        "issueSummary",
      );
      if (value.pull_request !== undefined)
        return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
      return toIssue(value);
    }),
    listIssues: Effect.fn("GitHubIssueProvider.listIssues")(function* (input) {
      // REST's issues endpoint also returns PRs. Follow its pages, filtering them before the
      // issue limit, so a page of PRs does not hide issues waiting on a subsequent page.
      const search = (input.query?.trim().length ?? 0) > 0;
      const sort = input.sort ?? "updated";
      const githubSort = sort === "newest" || sort === "oldest" ? "created" : sort;
      const direction = sort === "oldest" ? "asc" : "desc";
      const parsed = parseIssueSearch(input.query ?? "");
      const query = [
        `repo:${input.repository}`,
        "is:issue",
        ...(parsed.state !== undefined || input.state === "all" ? [] : [`is:${input.state}`]),
        input.query?.trim() ?? "",
        ...(input.filters?.author ? [`author:${input.filters.author}`] : []),
        ...(input.filters?.labels ?? []).map((label) => `label:${JSON.stringify(label)}`),
      ]
        .filter(Boolean)
        .join(" ");
      if (input.cursor !== undefined && !/^\d+:\d+$/.test(input.cursor))
        return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
      const cursor = input.cursor === undefined ? [1, 0] : input.cursor.split(":").map(Number);
      let page = cursor[0] ?? 0;
      let offset = cursor[1] ?? 0;
      if (
        cursor.length !== 2 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > (search ? 10 : 100_000) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= 100
      )
        return yield* new IssueOperationError({ host: input.host, reason: "invalid-response" });
      const repository = input.repository.split("/").map(encodeURIComponent).join("/");
      const items: ProviderIssue[] = [];
      // Bound one read even when the repository has many PR-only REST pages.
      // The cursor lets the caller continue without spending an unbounded request burst.
      let pagesRead = 0;
      while (items.length < input.limit && pagesRead < 10) {
        pagesRead += 1;
        const perPage = 100;
        const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
        let value: ReadonlyArray<typeof Row.Type>;
        let more: boolean;
        if (search) {
          params.set("q", query);
          params.set("sort", githubSort);
          params.set("order", direction);
          const response = yield* read(
            input.host,
            `search/issues?${params}`,
            Schema.Struct({
              total_count: NonNegativeInt,
              incomplete_results: Schema.Boolean,
              items: Schema.Array(Row),
            }),
          );
          if (response.value.incomplete_results)
            return yield* new IssueOperationError({ host: input.host, reason: "invalid-query" });
          value = response.value.items;
          // GitHub search exposes at most 1,000 results. Do not issue an invalid page 11.
          more = page < 10 && page * perPage < Math.min(response.value.total_count, 1000);
        } else {
          params.set("state", input.state);
          params.set("sort", githubSort);
          params.set("direction", direction);
          if (input.filters?.author) params.set("creator", input.filters.author);
          if (input.filters?.labels?.length) params.set("labels", input.filters.labels.join(","));
          const response = yield* read(
            input.host,
            `repos/${repository}/issues?${params}`,
            Schema.Array(Row),
          );
          value = response.value;
          more = /rel="next"/.test(response.headers.link ?? "");
        }
        for (let index = offset; index < value.length; index += 1) {
          const row = value[index]!;
          if (row.pull_request !== undefined) continue;
          // A caller's repo qualifiers must never expand the configured repository scope.
          if (search) {
            const url = URL.parse(row.html_url);
            if (url === null)
              return yield* new IssueOperationError({
                host: input.host,
                reason: "invalid-response",
              });
            if (
              url.host.toLowerCase() !== input.host.toLowerCase() ||
              url.pathname.toLowerCase() !==
                `/${input.repository}/issues/${row.number}`.toLowerCase()
            )
              continue;
          }
          items.push(toIssue(row));
          if (items.length === input.limit)
            return {
              items,
              nextCursor:
                index + 1 < value.length ? `${page}:${index + 1}` : more ? `${page + 1}:0` : null,
            };
        }
        if (!more) return { items, nextCursor: null };
        page += 1;
        offset = 0;
      }
      return { items, nextCursor: `${page}:${offset}` };
    }),
  };
  return provider;
});
