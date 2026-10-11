import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  availableIssuesToLink,
  resolveIssueLinkActivation,
  resolveIssueLinkTarget,
  resolveIssueReference,
} from "./issueLink.logic";

it("resolves a GitHub issue URL to one canonical identity and rejects pull requests", () => {
  expect(resolveIssueReference("https://GITHUB.com/Owner/Repo/issues/5?x=1#comment", null)).toEqual(
    { host: "github.com", repository: "owner/repo", number: 5 },
  );
  expect(resolveIssueReference("#12", { host: "github.com", repository: "Owner/Repo" })).toEqual({
    host: "github.com",
    repository: "owner/repo",
    number: 12,
  });
  for (const value of [
    "https://github.com/owner/repo/pull/5",
    "javascript:alert(1)",
    "#0",
    "12",
    "https://github.com/owner/repo/issues/5/extra",
  ])
    expect(resolveIssueReference(value, null)).toBeNull();
});
it("finds matching issues while excluding identities already attached to the thread", () => {
  const entries = [
    { host: "github.com", repository: "owner/repo", number: 5, title: "Fix bug" },
    { host: "github.com", repository: "owner/repo", number: 6, title: "Fix performance" },
  ];
  expect(
    availableIssuesToLink(
      entries,
      [{ host: "GITHUB.COM", repository: "Owner/Repo", number: 5 }],
      "fix",
    ),
  ).toEqual([entries[1]]);
  expect(availableIssuesToLink(entries, [], "unrelated")).toEqual([]);
});

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("checkout");
const project = {
  id: projectId,
  environmentId,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/repo",
    displayName: "acme/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/repo.git",
    },
  },
} satisfies Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">;

describe("issue chat links", () => {
  it("resolves a configured GitHub issue into the owning environment's detail input", () => {
    expect(
      resolveIssueLinkTarget({
        environmentId,
        projects: [project],
        issuesEnabled: true,
        url: "https://github.com/Acme/Repo/issues/8#issuecomment-1",
      }),
    ).toEqual({
      environmentId,
      input: { projectId, host: "github.com", repository: "acme/repo", number: 8 },
    });
  });

  it("opens a resolved issue in the selected environment", async () => {
    const input = { projectId, host: "github.com", repository: "acme/repo", number: 8 };
    expect(
      await resolveIssueLinkActivation({
        target: { environmentId, input },
        event: { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        readDetail: async () => input,
      }),
    ).toEqual({ environmentId, ...input });
  });

  it("keeps an unreadable issue on the browser path", async () => {
    expect(
      await resolveIssueLinkActivation({
        target: {
          environmentId,
          input: { projectId, host: "github.com", repository: "acme/repo", number: 8 },
        },
        event: { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        readDetail: async () => {
          throw new Error("Issue not found");
        },
      }),
    ).toBeNull();
  });

  it("keeps a failed issue detail response on the browser path", async () => {
    expect(
      await resolveIssueLinkActivation({
        target: {
          environmentId,
          input: { projectId, host: "github.com", repository: "acme/repo", number: 8 },
        },
        event: { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
        readDetail: async () => null,
      }),
    ).toBeNull();
  });

  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)(
    "%s activation leaves the native browser link untouched without reading issue detail",
    async (modifier) => {
      const input = { projectId, host: "github.com", repository: "acme/repo", number: 8 };
      const readDetail = vi.fn(async () => input);
      expect(
        await resolveIssueLinkActivation({
          target: { environmentId, input },
          event: {
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            [modifier]: true,
          },
          readDetail,
        }),
      ).toBeNull();
      expect(readDetail).not.toHaveBeenCalled();
    },
  );

  it("selects the chat environment when several environments have the same repository", () => {
    const otherProject = {
      ...project,
      id: ProjectId.make("other-checkout"),
      environmentId: EnvironmentId.make("local"),
    };
    expect(
      resolveIssueLinkTarget({
        environmentId,
        projects: [otherProject, project],
        issuesEnabled: true,
        url: "https://github.com/acme/repo/issues/8",
      }),
    ).toEqual({
      environmentId,
      input: { projectId, host: "github.com", repository: "acme/repo", number: 8 },
    });
  });

  it("uses the same first matching checkout as existing source-control routing within an environment", () => {
    const duplicate = { ...project, id: ProjectId.make("duplicate-checkout") };
    expect(
      resolveIssueLinkTarget({
        environmentId,
        projects: [duplicate, project],
        issuesEnabled: true,
        url: "https://github.com/acme/repo/issues/8",
      })?.input.projectId,
    ).toBe(duplicate.id);
  });

  it("keeps issue links ordinary when the environment capability is missing", () => {
    expect(
      resolveIssueLinkTarget({
        environmentId,
        projects: [project],
        issuesEnabled: false,
        url: "https://github.com/acme/repo/issues/8",
      }),
    ).toBeNull();
  });

  it("does not borrow another environment's checkout", () => {
    expect(
      resolveIssueLinkTarget({
        environmentId: EnvironmentId.make("unconfigured"),
        projects: [project],
        issuesEnabled: true,
        url: "https://github.com/acme/repo/issues/8",
      }),
    ).toBeNull();
  });

  it("keeps links without a chat environment ordinary", () => {
    expect(
      resolveIssueLinkTarget({
        environmentId: null,
        projects: [project],
        issuesEnabled: true,
        url: "https://github.com/acme/repo/issues/8",
      }),
    ).toBeNull();
  });

  it("requires a GitHub repository identity", () => {
    expect(
      resolveIssueLinkTarget({
        environmentId,
        projects: [
          { ...project, repositoryIdentity: { ...project.repositoryIdentity, provider: "gitlab" } },
        ],
        issuesEnabled: true,
        url: "https://github.com/acme/repo/issues/8",
      }),
    ).toBeNull();
  });

  it.each([
    "https://github.com/other/repo/issues/8",
    "https://github.com/acme/repo/pull/8",
    "https://github.com/acme/repo",
    "https://github.com/acme/repo/issues/0",
    "https://github.com/acme/repo/issues/9007199254740992",
    "https://github.com/acme/repo/issues/8suffix",
    "https://github.com.evil.test/acme/repo/issues/8",
    "https://gitlab.com/acme/repo/-/issues/8",
    "http://github.com/acme/repo/issues/8",
    "https://user:secret@github.com/acme/repo/issues/8",
    "not a URL",
  ])("leaves unconfigured or non-issue link %s unchanged", (url) => {
    expect(
      resolveIssueLinkTarget({ environmentId, projects: [project], issuesEnabled: true, url }),
    ).toBeNull();
  });
});
