import { expect, it } from "vite-plus/test";
import { resolveIssueReference, availableIssuesToLink } from "./issueLink.logic";

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
