import { ProjectId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  IssueDetail,
  IssueRef,
  IssueListInput,
  IssueListResult,
  IssueCommentInput,
  IssueSetStateInput,
  IssueSetLabelsInput,
} from "./issue.ts";

const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const encodeDetail = Schema.encodeSync(IssueDetail);
const decodeRef = Schema.decodeUnknownSync(IssueRef);
const decode = Schema.decodeUnknownSync(IssueListInput);
const decodeResult = Schema.decodeUnknownSync(IssueListResult);
const encodeResult = Schema.encodeSync(IssueListResult);

it("bounds issue reads and round-trips an empty list", () => {
  expect(decode({ state: "open" })).toEqual({ state: "open" });
  for (const limit of [0, 501]) expect(() => decode({ state: "open", limit })).toThrow();
  expect(() => decode({ state: "merged" })).toThrow();
  const result = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
  };
  expect(decodeResult(encodeResult(result))).toEqual(result);
});

it("round-trips issue details with empty descriptions and comment authors", () => {
  const detail = {
    provider: "github" as const,
    host: "github.com",
    projectId: ProjectId.make("project"),
    projectTitle: "Web",
    workspaceRoot: "/repo",
    repository: "acme/web",
    number: 42,
    title: "Fix bug",
    url: "https://github.com/acme/web/issues/42",
    author: null,
    state: "closed" as const,
    labels: [{ name: "bug", color: "ff0000" }],
    assignees: [],
    commentCount: 1,
    body: "",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    comments: [
      {
        id: 7,
        url: "https://github.com/acme/web/issues/42#issuecomment-7",
        author: null,
        body: "Done",
        createdAt: "2026-07-02T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
      },
    ],
    commentsTruncated: false,
  };
  expect(decodeDetail(encodeDetail(detail))).toEqual(detail);
  expect(() =>
    decodeRef({ projectId: "project", host: "github.com", repository: "acme/web", number: 0 }),
  ).toThrow();
  expect(() => decodeRef({ host: "github.com", repository: "acme/web", number: 42 })).toThrow();
});

it("bounds issue writes and permits clearing all labels", () => {
  const reference = { projectId: "project", host: "github.com", repository: "acme/web", number: 2 };
  const comment = Schema.decodeUnknownSync(IssueCommentInput);
  expect(comment({ ...reference, body: "  Confirmed  " }).body).toBe("Confirmed");
  expect(() => comment({ ...reference, body: "   " })).toThrow();
  expect(() => comment({ ...reference, body: "x".repeat(65537) })).toThrow();
  const state = Schema.decodeUnknownSync(IssueSetStateInput);
  expect(state({ ...reference, state: "closed" }).state).toBe("closed");
  expect(() => state({ ...reference, state: "merged" })).toThrow();
  const labels = Schema.decodeUnknownSync(IssueSetLabelsInput);
  expect(labels({ ...reference, labels: [] }).labels).toEqual([]);
  expect(() => labels({ ...reference, labels: [" "] })).toThrow();
  expect(() => labels({ ...reference, labels: ["x".repeat(101)] })).toThrow();
  expect(() =>
    labels({ ...reference, labels: Array.from({ length: 101 }, () => "bug") }),
  ).toThrow();
});

it("round-trips closed scope, qualifier search, filters and sorts while bounding query and cursors", () => {
  const input = {
    state: "closed",
    query: 'label:"needs review" author:octocat is:open',
    filters: { labels: ["bug"], author: "octocat" },
    sort: "comments",
    cursors: { "github.com acme/web": "2:3" },
  };
  expect(decode(input)).toEqual(input);
  for (const invalid of [
    { query: "x".repeat(257) },
    { sort: "random" },
    { filters: { labels: Array(11).fill("bug") } },
    { cursors: { "github.com acme/web": "x".repeat(4097) } },
  ])
    expect(() => decode({ state: "open", ...invalid })).toThrow();
});
