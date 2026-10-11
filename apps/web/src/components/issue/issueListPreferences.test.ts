import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type IssueListEntry } from "@t3tools/contracts";
import {
  readIssueListPreferences,
  writeIssueListPreferences,
  validateIssueListSearch,
  readIssueListSnapshot,
  writeIssueListSnapshot,
} from "./issueListPreferences";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
it("restores every list choice on reload while explicit URL choices override saved preferences", () => {
  const saved = storage();
  const choices = {
    state: "closed" as const,
    issueInvolvement: "assigned" as const,
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("p"),
    host: "ghe.example",
    author: "alice",
    labels: ["bug"],
    issueSort: "comments" as const,
    q: 'label:"bug" is:closed',
  };
  writeIssueListPreferences(choices, saved);
  expect(validateIssueListSearch({}, readIssueListPreferences(saved))).toEqual(choices);
  expect(validateIssueListSearch({ state: "all" }, readIssueListPreferences(saved))).toEqual({
    state: "all",
    issueInvolvement: "all",
    issueSort: "updated",
  });
  expect(validateIssueListSearch({ state: "wrong", q: "x".repeat(257) })).toEqual({
    state: "open",
    issueInvolvement: "all",
    issueSort: "updated",
  });
});
it("reads a validated last-list snapshot synchronously for its exact scope before any live answer", () => {
  const saved = storage();
  const values = [
    [
      EnvironmentId.make("env"),
      {
        viewers: { "github.com": "alice" },
        providers: [],
        entries: [],
        errors: [],
        truncated: false,
        nextCursors: {},
      },
    ],
  ] as const;
  writeIssueListSnapshot("closed/alice", values, saved);
  expect(readIssueListSnapshot("closed/alice", saved)).toEqual(values);
  expect(readIssueListSnapshot("open/bob", saved)).toBeNull();
  saved.setItem("t3.issues.list", '{"key":"closed/alice","values":[["env",{}]]}');
  expect(readIssueListSnapshot("closed/alice", saved)).toBeNull();
});

it("caps saved rows across environments and tolerates unavailable local storage", () => {
  const saved = storage();
  const row: IssueListEntry = {
    provider: "github",
    host: "github.com",
    repository: "acme/web",
    projectId: ProjectId.make("p"),
    projectTitle: "Web",
    number: 1,
    title: "Saved issue",
    url: "https://github.com/acme/web/issues/1",
    author: null,
    state: "closed",
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
  const result = {
    viewers: {},
    providers: [],
    entries: Array.from({ length: 80 }, (_, index) => ({ ...row, number: index + 1 })),
    errors: [],
    truncated: true,
    nextCursors: { "github.com acme/web": "2:0" },
  };
  writeIssueListSnapshot(
    "scope",
    [
      [EnvironmentId.make("first"), result],
      [EnvironmentId.make("second"), result],
    ],
    saved,
  );
  const painted = readIssueListSnapshot("scope", saved)!;
  expect(painted.map(([, value]) => value.entries.length)).toEqual([80, 20]);
  expect(painted[0]?.[1].entries[0]?.title).toBe("Saved issue");
  expect(painted[0]?.[1].nextCursors).toEqual({});
  const denied = {
    getItem: () => {
      throw new Error("Denied");
    },
    setItem: () => {
      throw new Error("Denied");
    },
  };
  expect(readIssueListSnapshot("scope", denied)).toBeNull();
  expect(() => writeIssueListSnapshot("scope", [], denied)).not.toThrow();
  expect(readIssueListPreferences(denied).state).toBe("open");
});
