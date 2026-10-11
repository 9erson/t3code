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
  ) =>
    api.rest({ host, path, operation }).pipe(
      Effect.mapError(failure),
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
      const cursor = input.cursor === undefined ? [1, 0] : input.cursor.split(":").map(Number);
      let page = cursor[0] ?? 0;
      let offset = cursor[1] ?? 0;
      if (
        cursor.length !== 2 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 100_000 ||
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
        const { value, headers } = yield* read(
          input.host,
          `repos/${repository}/issues?state=${input.state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
          Schema.Array(Row),
        );
        const more = /rel="next"/.test(headers.link ?? "");
        for (let index = offset; index < value.length; index += 1) {
          const row = value[index]!;
          if (row.pull_request !== undefined) continue;
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
