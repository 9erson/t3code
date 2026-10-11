import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as IssueReadCache from "./IssueReadCache.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { IssueOperationError, ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import type { IssueProviderApi } from "@t3tools/source-control-core/server/IssueProvider";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueProviderRegistry from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

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
  kind: "github",
  getIssue: () => Effect.die("List tests do not read individual issues"),
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
  "refreshes a linked issue's current state after invalidation without depending on open-list membership",
  () =>
    Effect.gen(function* () {
      let state: "open" | "closed" = "open";
      const service = yield* make([project("healthy", "github.com")], {
        ...provider,
        getIssue: () =>
          Effect.succeed({
            number: 5,
            title: "Linked bug",
            url: "https://github.com/acme/healthy/issues/5",
            author: null,
            labels: [],
            assignees: [],
            commentCount: 0,
            state,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-02T00:00:00Z",
          }),
      });
      const key = { host: "GITHUB.COM", repository: "Acme/Healthy", number: 5 };
      expect((yield* service.summary(key)).state).toBe("open");
      state = "closed";
      yield* service.invalidate();
      expect(yield* service.summary(key)).toMatchObject({
        host: "github.com",
        repository: "acme/healthy",
        number: 5,
        state: "closed",
      });
    }),
);
