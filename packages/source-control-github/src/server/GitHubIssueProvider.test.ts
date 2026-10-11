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
