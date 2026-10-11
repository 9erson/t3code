import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import { groupIssues, mergeIssueLists, filterIssues } from "./issueList.logic";
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

it("filters by state, labels, author, project, host and involvement without moving rows between groups", () => {
  const base = {
    ...entry(1, "Alice", ["me"], "2026-07-01T00:00:00Z"),
    environmentId: EnvironmentId.make("env"),
    viewer: "me",
    labels: [{ name: "Bug", color: null }],
  };
  const rows = [
    base,
    { ...base, number: 2, state: "closed" as const },
    { ...base, number: 3, host: "ghe.example" },
    { ...base, number: 4, labels: [] },
    { ...base, number: 5, author: { login: "bob", name: null, avatarUrl: null } },
    { ...base, number: 6, projectId: ProjectId.make("other") },
  ];
  expect(
    filterIssues(rows, {
      state: "open",
      host: "GitHub.com",
      author: "alice",
      labels: ["bug"],
      projectId: ProjectId.make("p"),
      involvement: "assigned",
    }).map((row) => row.number),
  ).toEqual([1]);
  expect(filterIssues(rows, { state: "all", involvement: "authored" })).toEqual([]);
});

it("orders each involvement group by updated, newest, oldest or most commented with stable ties", () => {
  const rows = [
    {
      ...entry(1, "me", [], "2026-07-04T00:00:00Z"),
      createdAt: "2026-07-01T00:00:00Z",
      commentCount: 2,
    },
    {
      ...entry(2, "me", [], "2026-07-02T00:00:00Z"),
      createdAt: "2026-07-03T00:00:00Z",
      commentCount: 9,
    },
    {
      ...entry(3, "me", [], "2026-07-03T00:00:00Z"),
      createdAt: "2026-07-02T00:00:00Z",
      commentCount: 5,
    },
  ].map((row) => ({ ...row, environmentId: EnvironmentId.make("env"), viewer: "me" }));
  for (const [sort, expected] of [
    ["updated", [1, 3, 2]],
    ["newest", [2, 3, 1]],
    ["oldest", [1, 3, 2]],
    ["comments", [2, 3, 1]],
  ] as const)
    expect(groupIssues(rows, sort)[1]?.entries.map((row) => row.number)).toEqual(expected);
});
