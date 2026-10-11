import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import { groupIssues, mergeIssueLists } from "./issueList.logic";
const entry = (
  number: number,
  author: string,
  assignees: string[],
  updatedAt: string,
): IssueListEntry => ({
  number,
  provider: "github",
  host: "github.com",
  repository: "acme/web",
  projectId: ProjectId.make("p"),
  projectTitle: "Web",
  title: "An issue",
  url: `https://github.com/acme/web/issues/${number}`,
  state: "open",
  labels: [],
  commentCount: 0,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt,
  author: { login: author, name: null, avatarUrl: null },
  assignees: assignees.map((login) => ({ login, name: null, avatarUrl: null })),
});
it("groups by each environment's viewer with assignment taking precedence and newest updates first", () => {
  const answer: IssueListResult = {
    viewers: { "github.com": "OCTOCAT" },
    providers: [],
    errors: [],
    truncated: false,
    nextCursors: {},
    entries: [
      entry(1, "octocat", ["octocat"], "2026-07-01T00:00:00Z"),
      entry(2, "someone", ["octocat"], "2026-07-03T00:00:00Z"),
      entry(3, "octocat", [], "2026-07-02T00:00:00Z"),
      entry(4, "someone", [], "2026-07-02T00:00:00Z"),
    ],
  };
  const groups = groupIssues(mergeIssueLists([[EnvironmentId.make("env"), answer]]).entries);
  expect(groups.map((group) => [group.title, group.entries.map((row) => row.number)])).toEqual([
    ["Assigned to you", [2, 1]],
    ["Created by you", [3]],
    ["Others", [4]],
  ]);
});

it("keeps each environment's viewer identity while merging healthy rows and error summaries", () => {
  const first: IssueListResult = {
    viewers: { "github.com": "alice" },
    providers: [],
    errors: [],
    truncated: false,
    nextCursors: {},
    entries: [entry(1, "alice", [], "2026-07-01T00:00:00Z")],
  };
  const second: IssueListResult = {
    ...first,
    viewers: { "github.com": "bob" },
    entries: [entry(2, "bob", [], "2026-07-02T00:00:00Z")],
    errors: [
      { projectId: ProjectId.make("failed"), projectTitle: "Failed", message: "Sign in to GitHub" },
    ],
  };
  const merged = mergeIssueLists([
    [EnvironmentId.make("first"), first],
    [EnvironmentId.make("second"), second],
  ]);
  expect(groupIssues(merged.entries)[1]?.entries.map((row) => row.number)).toEqual([2, 1]);
  expect(merged.errors[0]).toMatchObject({ environmentId: "second", message: "Sign in to GitHub" });
});
