import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubIssueProvider from "@t3tools/source-control-github/server/GitHubIssueProvider";
import * as Redacted from "effect/Redacted";
import * as IssueReadCache from "./IssueReadCache.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { IssueOperationError, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import type { IssueProviderApi } from "@t3tools/source-control-core/server/IssueProvider";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueProviderRegistry from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

const decodeStateBody = Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }));
const decodeLabelsBody = Schema.decodeUnknownSync(
  Schema.Struct({ labels: Schema.Array(Schema.String) }),
);

const project = (id: string, host?: string, provider = "github"): OrchestrationProjectShell => ({
  id: id as ProjectId,
  title: id,
  workspaceRoot: `/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
  ...(host === undefined
    ? {}
    : {
        repositoryIdentity: {
          canonicalKey: `${host}/acme/${id}`,
          provider,
          displayName: `acme/${id}`,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${host}/acme/${id}.git`,
          },
        },
      }),
});
const projects = [
  project("healthy", "github.com"),
  project("broken", "ghe.example"),
  project("other", "gitlab.com", "gitlab"),
  project("local"),
];
const provider: IssueProviderApi = {
  comment: () => Effect.die("No comment fixture"),
  setState: () => Effect.die("No state fixture"),
  setLabels: () => Effect.die("No labels fixture"),
  labelCandidates: () => Effect.die("No labels fixture"),
  kind: "github",
  getIssue: (input) =>
    provider.listIssues({ ...input, state: "open", limit: 1 }).pipe(
      Effect.map((page) => ({
        ...page.items[0]!,
        number: input.number,
        body: "Issue body",
        comments: [],
        commentsTruncated: false,
      })),
    ),
  getViewer: ({ host }) =>
    host === "ghe.example"
      ? Effect.fail(new IssueOperationError({ host, reason: "credentials-missing" }))
      : Effect.succeed("octocat"),
  listIssues: () =>
    Effect.succeed({
      items: [
        {
          number: 2,
          title: "Fix bug",
          url: "https://github.com/acme/healthy/issues/2",
          author: null,
          assignees: [],
          labels: [],
          commentCount: 0,
          state: "open",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
        },
      ],
      nextCursor: null,
    }),
};
const make = (
  rows = projects,
  selectedProvider = provider,
  cache?: IssueReadCache.IssueReadCache["Service"],
  resolve: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"] = () =>
    Effect.succeed(null),
) =>
  IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        cache === undefined
          ? Layer.effect(IssueReadCache.IssueReadCache, IssueReadCache.make).pipe(
              Layer.provide(KeyValueStore.layerMemory),
              Layer.provide(NodeCrypto.layer),
            )
          : Layer.succeed(IssueReadCache.IssueReadCache, cache),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(rows),
          getShell: (id) => Effect.succeed(Option.fromNullishOr(rows.find((p) => p.id === id))),
        }),
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve,
        }),
        Layer.succeed(IssueProviderRegistry.IssueProviderRegistry, {
          get: (kind) => (kind === "github" ? selectedProvider : null),
        }),
      ),
    ),
  );

it.effect("keeps healthy issues when another host fails and explains unsupported hosts", () =>
  Effect.gen(function* () {
    const service = yield* make();
    const result = yield* service.list({ state: "open" });
    expect(result.entries.map((row) => row.projectId)).toEqual(["healthy"]);
    expect(result.viewers).toEqual({ "github.com": "octocat" });
    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "ghe.example",
          configured: false,
          detail: expect.stringContaining("GH_TOKEN"),
        }),
        expect.objectContaining({
          host: "gitlab.com",
          configured: false,
          detail: "This host cannot be browsed here yet.",
        }),
      ]),
    );
    expect(result.providers).toHaveLength(3);
    expect(result.errors.map((error) => error.projectId)).toEqual(["broken"]);
  }),
);

it.effect(
  "shares a recent list across service instances and invalidates it for manual refresh",
  () =>
    Effect.gen(function* () {
      const cache = yield* IssueReadCache.make.pipe(
        Effect.provide(Layer.merge(KeyValueStore.layerMemory, NodeCrypto.layer)),
      );
      const first = yield* make([projects[0]!], provider, cache);
      expect((yield* first.list({ state: "open" })).entries[0]?.title).toBe("Fix bug");
      const second = yield* make(
        [projects[0]!],
        {
          ...provider,
          listIssues: (input) =>
            provider.listIssues(input).pipe(
              Effect.map((page) => ({
                ...page,
                items: page.items.map((row) => ({ ...row, title: "Updated" })),
              })),
            ),
        },
        cache,
      );
      expect((yield* second.list({ state: "open" })).entries[0]?.title).toBe("Fix bug");
      yield* second.invalidate();
      expect((yield* second.list({ state: "open" })).entries[0]?.title).toBe("Updated");
    }),
);

it.effect("returns the actionable credential error when every readable host is signed out", () =>
  Effect.gen(function* () {
    const service = yield* make([projects[1]!]);
    const result = yield* service.list({ state: "open" }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("credentials-missing");
      expect(result.failure.message).toContain("gh auth login --hostname ghe.example");
    }
  }),
);

it.effect("keeps other repositories when a repository list request fails", () =>
  Effect.gen(function* () {
    const service = yield* make([projects[0]!, project("second", "github.com")], {
      ...provider,
      listIssues: (input) =>
        input.repository === "acme/second"
          ? Effect.fail(
              new IssueOperationError({ host: input.host, reason: "rate-limited", retryAt: 1234 }),
            )
          : provider.listIssues(input),
    });
    const result = yield* service.list({ state: "all" });
    expect(result.entries.map((entry) => entry.number)).toEqual([2]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        projectId: "second",
        message: expect.stringContaining("rate limit"),
      }),
    ]);
    expect(result.providers[0]?.detail).toContain("rate limit");
  }),
);

it.effect("refines stored unknown hosts through the git-remote resolver", () =>
  Effect.gen(function* () {
    const unknown = project("enterprise", "ghe.example", "unknown");
    const service = yield* make(
      [unknown],
      { ...provider, getViewer: () => Effect.succeed("octocat") },
      undefined,
      () => Effect.succeed({ ...unknown.repositoryIdentity!, provider: "github" }),
    );
    const answer = yield* service.list({ state: "open" });
    expect(answer.entries.map((row) => row.projectId)).toEqual(["enterprise"]);
    expect(answer.providers[0]?.kind).toBe("github");
  }),
);

it.effect(
  "coalesces simultaneous detail reads and refreshes cached details after invalidation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let requests = 0;
        const github = yield* GitHubIssueProvider.make.pipe(
          Effect.provideService(GitHubApi.GitHubApi, {
            credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
            graphql: () => Effect.die("REST only"),
            rest: ({ path }) =>
              Effect.gen(function* () {
                if (path.includes("/comments?"))
                  return {
                    status: 200,
                    headers: {},
                    truncated: false,
                    invalidUtf8: false,
                    body: "[]",
                  };
                requests += 1;
                const revision = requests;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  status: 200,
                  headers: {},
                  truncated: false,
                  invalidUtf8: false,
                  body: JSON.stringify({
                    number: 2,
                    title: "Fix bug",
                    html_url: "https://github.com/acme/healthy/issues/2",
                    user: null,
                    labels: [],
                    assignees: [],
                    comments: 0,
                    state: "open",
                    body: `Revision ${revision}`,
                    created_at: "2026-07-01T00:00:00Z",
                    updated_at: "2026-07-02T00:00:00Z",
                  }),
                };
              }),
          }),
        );
        const service = yield* make([projects[0]!], github);
        const input = {
          projectId: projects[0]!.id,
          host: "github.com",
          repository: "acme/healthy",
          number: 2,
        };
        const reads = yield* Effect.all([service.detail(input), service.detail(input)], {
          concurrency: 2,
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        const answers = yield* Fiber.join(reads);
        expect(answers.map((detail) => detail.body)).toEqual(["Revision 1", "Revision 1"]);
        expect(answers[0]).toMatchObject({
          projectId: "healthy",
          host: "github.com",
          workspaceRoot: "/healthy",
          repository: "acme/healthy",
        });
        expect((yield* service.detail(input)).body).toBe("Revision 1");
        expect(requests).toBe(1);
        yield* service.invalidate();
        expect((yield* service.detail(input)).body).toBe("Revision 2");
      }),
    ),
);

it.effect("does not cache failed detail reads and refuses a stale repository selection", () =>
  Effect.gen(function* () {
    let signedIn = false;
    const service = yield* make([projects[0]!], {
      ...provider,
      getIssue: (input) =>
        signedIn
          ? provider.getIssue(input)
          : Effect.fail(
              new IssueOperationError({ host: input.host, reason: "credentials-missing" }),
            ),
    });
    const input = {
      projectId: projects[0]!.id,
      host: "github.com",
      repository: "acme/healthy",
      number: 2,
    };
    expect(yield* service.detail(input).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "credentials-missing" },
    });
    signedIn = true;
    expect((yield* service.detail(input)).body).toBe("Issue body");
    expect(
      yield* service.detail({ ...input, repository: "acme/old" }).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "not-found" } });
  }),
);

it.effect("comments invalidate cached timelines and reject a stale repository before writing", () =>
  Effect.gen(function* () {
    const writes: GitHubApi.GitHubRestInput[] = [];
    const comment = {
      id: 42,
      html_url: "https://github.com/acme/healthy/issues/2#issuecomment-42",
      user: null,
      body: "Confirmed",
      created_at: "2026-07-02T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    };
    const github = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: (request) => {
          if (request.method === "POST") writes.push(request);
          return Effect.succeed({
            status: 200,
            headers: {},
            truncated: false,
            invalidUtf8: false,
            body: JSON.stringify(
              request.method === "POST"
                ? comment
                : request.path.includes("/comments?")
                  ? writes.length === 0
                    ? []
                    : [comment]
                  : request.path === "user"
                    ? { login: "octocat" }
                    : request.path.includes("/issues?")
                      ? []
                      : {
                          number: 2,
                          title: "Fix bug",
                          html_url: "https://github.com/acme/healthy/issues/2",
                          user: null,
                          labels: [],
                          assignees: [],
                          comments: writes.length,
                          state: "open",
                          body: "Issue body",
                          created_at: comment.created_at,
                          updated_at: comment.updated_at,
                        },
            ),
          });
        },
      }),
    );
    const service = yield* make([projects[0]!], github);
    const input = {
      projectId: projects[0]!.id,
      host: "github.com",
      repository: "acme/healthy",
      number: 2,
    };
    expect((yield* service.detail(input)).comments).toEqual([]);
    expect((yield* service.comment({ ...input, body: "Confirmed" })).id).toBe(42);
    expect((yield* service.detail(input)).comments.map((entry) => entry.body)).toEqual([
      "Confirmed",
    ]);
    const refused = yield* service
      .comment({ ...input, repository: "acme/old", body: "No" })
      .pipe(Effect.result);
    expect(refused).toMatchObject({ _tag: "Failure", failure: { reason: "not-found" } });
    expect(writes).toHaveLength(1);
  }),
);

it.effect("state and label writes refresh cached rows and details from GitHub", () =>
  Effect.gen(function* () {
    let row = {
      number: 2,
      title: "Fix bug",
      html_url: "https://github.com/acme/healthy/issues/2",
      user: null,
      labels: [] as { name: string; color: string }[],
      assignees: [],
      comments: 0,
      state: "open",
      body: "Issue body",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    };
    const github = yield* GitHubIssueProvider.make.pipe(
      Effect.provideService(GitHubApi.GitHubApi, {
        credential: () => Effect.succeed({ token: Redacted.make("fake"), fingerprint: "fake" }),
        graphql: () => Effect.die("REST only"),
        rest: (request) => {
          if (request.method === "PATCH")
            row = {
              ...row,
              state: Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String }))(request.body)
                .state,
            };
          if (request.method === "PUT")
            row = {
              ...row,
              labels: decodeLabelsBody(request.body).labels.map((name) => ({
                name,
                color: "ff0000",
              })),
            };
          return Effect.succeed({
            status: 200,
            headers: {},
            truncated: false,
            invalidUtf8: false,
            body: JSON.stringify(
              request.path === "user"
                ? { login: "octocat" }
                : request.path.includes("/comments?")
                  ? []
                  : request.path.includes("/issues?")
                    ? [row]
                    : request.path.includes("/labels?")
                      ? [{ name: "bug", color: "ff0000" }]
                      : request.method === "PUT"
                        ? row.labels
                        : row,
            ),
          });
        },
      }),
    );
    const service = yield* make([projects[0]!], github);
    const input = {
      projectId: projects[0]!.id,
      host: "github.com",
      repository: "acme/healthy",
      number: 2,
    };
    expect((yield* service.list({ state: "all" })).entries[0]?.state).toBe("open");
    expect((yield* service.detail(input)).labels).toEqual([]);
    const closed = yield* service.setState({ ...input, state: "closed" });
    expect(closed).toBe("closed");
    expect((yield* service.list({ state: "all" })).entries[0]?.state).toBe("closed");
    const candidates = yield* service.labelCandidates(input);
    expect(candidates).toEqual([{ name: "bug", color: "ff0000" }]);
    const labels = yield* service.setLabels({ ...input, labels: ["bug"] });
    expect(labels).toEqual([{ name: "bug", color: "ff0000" }]);
    expect((yield* service.detail(input)).labels).toEqual([{ name: "bug", color: "ff0000" }]);
    expect((yield* service.list({ state: "all" })).entries[0]?.labels).toEqual([
      { name: "bug", color: "ff0000" },
    ]);
  }),
);
