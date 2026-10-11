import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  issueCreationTargets,
  prepareIssueCreate,
  initialIssueComposerState,
  issueComposerReducer,
} from "./issueComposer.logic";

const environmentId = EnvironmentId.make("remote");
const target = {
  environmentId,
  projectId: ProjectId.make("project"),
  host: "ghe.example",
  repository: "acme/web",
  title: "Web",
  key: "remote:project:ghe.example/acme/web",
};

it("prepares the selected repository's issue without changing markdown", () => {
  const draft = {
    title: "  A bug  ",
    body: "  ```\nexample\n```\n",
    labels: ["bug"],
    assignees: ["octocat"],
  };
  expect(prepareIssueCreate(target, draft)).toMatchObject({
    _tag: "Success",
    success: {
      projectId: "project",
      host: "ghe.example",
      repository: "acme/web",
      title: "A bug",
      body: "  ```\nexample\n```\n",
      labels: ["bug"],
      assignees: ["octocat"],
    },
  });
});

it("keeps every draft field after a failed submission and clears only after success", () => {
  const draft = { title: "A bug", body: "## Steps", labels: ["bug"], assignees: ["octocat"] };
  const edited = issueComposerReducer(initialIssueComposerState, { type: "edit", patch: draft });
  const pending = issueComposerReducer(edited, { type: "submit" });
  const failed = issueComposerReducer(pending, {
    type: "failure",
    error: "GitHub refused the credential.",
  });
  expect(failed).toEqual({ draft, pending: false, error: "GitHub refused the credential." });
  expect(issueComposerReducer(failed, { type: "success" })).toEqual({
    draft: { title: "", body: "", labels: [], assignees: [] },
    pending: false,
    error: null,
  });
});

it("offers GitHub projects from capable environments with distinct multi-environment targets", () => {
  const identity = {
    canonicalKey: "ghe.example/acme/web",
    provider: "github",
    displayName: "acme/web",
    locator: {
      source: "git-remote" as const,
      remoteUrl: "https://ghe.example/acme/web.git",
      remoteName: "origin",
    },
  };
  const other = EnvironmentId.make("other");
  const projects = [
    { id: ProjectId.make("project"), title: "Web", environmentId, repositoryIdentity: identity },
    {
      id: ProjectId.make("project"),
      title: "Other Web",
      environmentId: other,
      repositoryIdentity: identity,
    },
    { id: ProjectId.make("local"), title: "Local", environmentId },
    {
      id: ProjectId.make("gitlab"),
      title: "GitLab",
      environmentId,
      repositoryIdentity: { ...identity, provider: "gitlab" },
    },
  ];
  expect(issueCreationTargets(projects, [environmentId, other])).toEqual([
    target,
    {
      ...target,
      environmentId: other,
      title: "Other Web",
      key: "other:project:ghe.example/acme/web",
    },
  ]);
  expect(issueCreationTargets(projects, [other])).toEqual([
    {
      ...target,
      environmentId: other,
      title: "Other Web",
      key: "other:project:ghe.example/acme/web",
    },
  ]);
});

it("returns a typed validation error for an empty title without mutating the draft", () => {
  const draft = { title: " ", body: "Keep these steps", labels: ["bug"], assignees: ["octocat"] };
  expect(prepareIssueCreate(target, draft)).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "IssueOperationError", reason: "invalid-input", host: "ghe.example" },
  });
  expect(draft).toEqual({
    title: " ",
    body: "Keep these steps",
    labels: ["bug"],
    assignees: ["octocat"],
  });
});
