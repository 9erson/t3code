import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as GitHubApi from "./GitHubApi.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";

const actor = { login: "octocat", avatar_url: "https://github.com/octocat.png" };
const issue = {
  number: 2,
  title: "A bug",
  html_url: "https://github.com/acme/web/issues/2",
  user: actor,
  state: "open",
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [actor],
  comments: 3,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};
const transport = Layer.succeed(
  GitHubApi.GitHubApi,
  GitHubApi.GitHubApi.of({
    credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
    graphql: () => Effect.die("Issues reads use REST"),
    rest: (input) =>
      Effect.succeed({
        status: 200,
        headers: {},
        truncated: false,
        invalidUtf8: false,
        body: JSON.stringify(
          input.path === "user" ? actor : [issue, { ...issue, number: 3, pull_request: {} }],
        ),
      }),
  }),
);

it.effect("lists issues with labels, assignees and counts while excluding pull requests", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubIssueProvider.make;
    expect(yield* provider.getViewer({ host: "github.com", cwd: "/repo" })).toBe("octocat");
    const page = yield* provider.listIssues({
      host: "github.com",
      repository: "acme/web",
      cwd: "/repo",
      state: "open",
      limit: 100,
    });
    expect(page.items).toEqual([
      {
        number: 2,
        title: "A bug",
        url: issue.html_url,
        author: { login: "octocat", name: null, avatarUrl: actor.avatar_url },
        state: "open",
        labels: [{ name: "bug", color: "ff0000" }],
        assignees: [{ login: "octocat", name: null, avatarUrl: actor.avatar_url }],
        commentCount: 3,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      },
    ]);
  }).pipe(Effect.provide(transport)),
);

it.effect("continues without skipping issues when REST pages contain pull requests", () =>
  Effect.gen(function* () {
    const api = GitHubApi.GitHubApi.of({
      credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
      graphql: () => Effect.die("REST only"),
      rest: (input) => {
        const page = new URL(`https://api.github.com/${input.path}`).searchParams.get("page");
        const values =
          page === "1"
            ? [{ ...issue, number: 1, pull_request: {} }, issue]
            : [
                { ...issue, number: 4 },
                { ...issue, number: 5 },
              ];
        return Effect.succeed({
          status: 200,
          headers: page === "1" ? { link: '<https://api.github.com/next>; rel="next"' } : {},
          truncated: false,
          invalidUtf8: false,
          body: JSON.stringify(values),
        });
      },
    });
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, api),
    );
    const input = {
      host: "github.com",
      repository: "acme/web",
      cwd: "/repo",
      state: "open" as const,
      limit: 2,
    };
    const first = yield* provider.listIssues(input);
    expect(first.items.map((row) => row.number)).toEqual([2, 4]);
    expect(first.nextCursor).not.toBeNull();
    const next = yield* provider.listIssues({ ...input, cursor: first.nextCursor! });
    expect(next.items.map((row) => row.number)).toEqual([5]);
    expect(next.nextCursor).toBeNull();
  }),
);

it.effect("reports a typed rate limit with its retry time", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: () =>
          Effect.fail(
            new GitHubApi.GitHubApiRateLimitError({
              host: "github.com",
              operation: "listIssues",
              retryAt: 1234,
            }),
          ),
      }),
    );
    const result = yield* provider
      .listIssues({
        host: "github.com",
        repository: "acme/web",
        cwd: "/repo",
        state: "open",
        limit: 100,
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        _tag: "IssueOperationError",
        reason: "rate-limited",
        retryAt: 1234,
      });
  }),
);

it.effect("reads an issue body and all comment pages in timeline order", () =>
  Effect.gen(function* () {
    const comment = {
      id: 7,
      html_url: "https://github.com/acme/web/issues/2#issuecomment-7",
      user: actor,
      body: "First reply",
      created_at: "2026-07-02T01:00:00Z",
      updated_at: "2026-07-02T01:00:00Z",
    };
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: ({ path }) =>
          Effect.succeed({
            status: 200,
            truncated: false,
            invalidUtf8: false,
            headers: path.endsWith("page=1")
              ? { link: '<https://api.github.com/next>; rel="next"' }
              : {},
            body: JSON.stringify(
              path.endsWith("issues/2")
                ? { ...issue, body: "Steps to reproduce" }
                : path.endsWith("page=1")
                  ? [comment]
                  : [{ ...comment, id: 8, body: "Second reply" }],
            ),
          }),
      }),
    );
    const detail = yield* provider.getIssue({
      host: "github.com",
      cwd: "/repo",
      repository: "acme/web",
      number: 2,
    });
    expect(detail).toMatchObject({
      title: "A bug",
      body: "Steps to reproduce",
      state: "open",
      labels: [{ name: "bug", color: "ff0000" }],
      author: { login: "octocat" },
    });
    expect(detail.comments.map(({ id, body }) => ({ id, body }))).toEqual([
      { id: 7, body: "First reply" },
      { id: 8, body: "Second reply" },
    ]);
    expect(detail.commentsTruncated).toBe(false);
  }),
);

it.effect("reports missing issue details distinctly from transient failures", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: () =>
          Effect.fail(
            new GitHubApi.GitHubApiNotFoundError({ host: "github.com", operation: "issueDetail" }),
          ),
      }),
    );
    const result = yield* provider
      .getIssue({ host: "github.com", cwd: "/repo", repository: "acme/web", number: 9 })
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IssueOperationError", reason: "not-found" },
    });
  }),
);

it.effect("keeps large timelines bounded and marks remaining comments", () =>
  Effect.gen(function* () {
    let pages = 0;
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: ({ path }) => {
          const comments = path.includes("/comments?");
          if (comments) pages += 1;
          return Effect.succeed({
            status: 200,
            truncated: false,
            invalidUtf8: false,
            headers: comments ? { link: '<https://api.github.com/next>; rel="next"' } : {},
            body: JSON.stringify(comments ? [] : { ...issue, body: null }),
          });
        },
      }),
    );
    const result = yield* provider.getIssue({
      host: "github.com",
      cwd: "/repo",
      repository: "acme/web",
      number: 2,
    });
    expect(result.body).toBe("");
    expect(result.commentsTruncated).toBe(true);
    expect(pages).toBe(10);
  }),
);

it.effect("refuses pull requests on the issue detail path", () =>
  Effect.gen(function* () {
    const provider = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: () =>
          Effect.succeed({
            status: 200,
            headers: {},
            truncated: false,
            invalidUtf8: false,
            body: JSON.stringify({ ...issue, body: "PR body", pull_request: {} }),
          }),
      }),
    );
    expect(
      yield* provider
        .getIssue({ host: "github.com", cwd: "/repo", repository: "acme/web", number: 2 })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-response" } });
  }),
);

it.effect(
  "uses native qualifier search scoped to issues in the configured repository, honoring typed state and sorting",
  () =>
    Effect.gen(function* () {
      let requested: URL | undefined;
      const provider = yield* GitHubIssueProvider.make.pipe(
        Effect.provideService(GitHubApi.GitHubApi, {
          credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
          graphql: () => Effect.die("REST only"),
          rest: (input) => {
            requested = new URL(`https://api.github.com/${input.path}`);
            return Effect.succeed({
              status: 200,
              headers: {},
              truncated: false,
              invalidUtf8: false,
              body: JSON.stringify({
                total_count: 1,
                incomplete_results: false,
                items: [{ ...issue, state: "closed" }],
              }),
            });
          },
        }),
      );
      const result = yield* provider.listIssues({
        host: "github.com",
        repository: "acme/web",
        cwd: "/repo",
        state: "open",
        limit: 1,
        query: 'label:"bug" author:octocat is:closed',
        sort: "comments",
        filters: { labels: ["triage"] },
      });
      expect(result.items.map((row) => [row.number, row.state])).toEqual([[2, "closed"]]);
      expect(requested?.pathname).toBe("/search/issues");
      expect(requested?.searchParams.get("q")).toBe(
        'repo:acme/web is:issue label:"bug" author:octocat is:closed label:"triage"',
      );
      expect(requested?.searchParams.get("sort")).toBe("comments");
      expect(requested?.searchParams.get("order")).toBe("desc");
      expect(result.nextCursor).toBeNull();
    }),
);

it.effect(
  "continues native search within fixed-size pages without skipping rows and stops at GitHub's search bound",
  () =>
    Effect.gen(function* () {
      const provider = yield* GitHubIssueProvider.make.pipe(
        Effect.provideService(GitHubApi.GitHubApi, {
          credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
          graphql: () => Effect.die("REST only"),
          rest: (input) => {
            const page = Number(
              new URL(`https://api.github.com/${input.path}`).searchParams.get("page"),
            );
            return Effect.succeed({
              status: 200,
              headers: {},
              truncated: false,
              invalidUtf8: false,
              body: JSON.stringify({
                total_count: 2000,
                incomplete_results: false,
                items: Array.from({ length: 100 }, (_, index) => {
                  const number = (page - 1) * 100 + index + 1;
                  return {
                    ...issue,
                    number,
                    html_url: `https://github.com/acme/web/issues/${number}`,
                  };
                }),
              }),
            });
          },
        }),
      );
      const input = {
        host: "github.com",
        cwd: "/repo",
        repository: "acme/web",
        state: "all" as const,
        limit: 3,
        query: "label:bug",
      };
      const first = yield* provider.listIssues(input);
      const second = yield* provider.listIssues({ ...input, cursor: first.nextCursor! });
      expect([...first.items, ...second.items].map((row) => row.number)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      const last = yield* provider.listIssues({ ...input, cursor: "10:98" });
      expect(last.items.map((row) => row.number)).toEqual([999, 1000]);
      expect(last.nextCursor).toBeNull();
      expect(
        (yield* provider.listIssues({ ...input, cursor: "11:0" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
);

it.effect(
  "maps search quota refusals and malformed qualifiers into actionable typed failures",
  () =>
    Effect.gen(function* () {
      for (const [error, expected] of [
        [
          new GitHubApi.GitHubApiRateLimitError({
            host: "github.com",
            operation: "searchIssues",
            retryAt: 1234,
          }),
          { reason: "rate-limited", rateLimitResource: "search", retryAt: 1234 },
        ],
        [
          new GitHubApi.GitHubApiResponseError({
            host: "github.com",
            operation: "searchIssues",
            status: 422,
          }),
          { reason: "invalid-query" },
        ],
      ] as const) {
        const provider = yield* GitHubIssueProvider.make.pipe(
          Effect.provideService(GitHubApi.GitHubApi, {
            credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
            graphql: () => Effect.die("REST only"),
            rest: () => Effect.fail(error),
          }),
        );
        const failure = yield* Effect.flip(
          provider.listIssues({
            host: "github.com",
            repository: "acme/web",
            cwd: "/repo",
            state: "open",
            limit: 10,
            query: "label:bug",
          }),
        );
        expect(failure).toMatchObject({ _tag: "IssueOperationError", ...expected });
      }
    }),
);

it.effect(
  "uses closed REST issue filters and the host's sort order before applying the page limit",
  () =>
    Effect.gen(function* () {
      for (const [sort, direction, githubSort] of [
        ["updated", "desc", "updated"],
        ["newest", "desc", "created"],
        ["oldest", "asc", "created"],
        ["comments", "desc", "comments"],
      ] as const) {
        let requested: URL | undefined;
        const provider = yield* GitHubIssueProvider.make.pipe(
          Effect.provideService(GitHubApi.GitHubApi, {
            credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
            graphql: () => Effect.die("REST only"),
            rest: (input) => {
              requested = new URL(`https://api.github.com/${input.path}`);
              return Effect.succeed({
                status: 200,
                headers: {},
                truncated: false,
                invalidUtf8: false,
                body: JSON.stringify([{ ...issue, state: "closed" }]),
              });
            },
          }),
        );
        const result = yield* provider.listIssues({
          host: "github.com",
          repository: "acme/web",
          cwd: "/repo",
          state: "closed",
          limit: 1,
          sort,
          filters: { author: "octocat", labels: ["bug", "help wanted"] },
        });
        expect(result.items[0]?.state).toBe("closed");
        expect(Object.fromEntries(requested!.searchParams)).toEqual({
          state: "closed",
          creator: "octocat",
          labels: "bug,help wanted",
          sort: githubSort,
          direction,
          per_page: "100",
          page: "1",
        });
      }
    }),
);
