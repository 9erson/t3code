import { expect, it } from "vite-plus/test";
import { parseIssueSearch } from "./issueSearch.ts";

it("recognizes state qualifiers without mistaking quoted text or negative qualifiers for a state", () => {
  expect(parseIssueSearch('label:"needs review" author:octocat is:open').state).toBe("open");
  expect(parseIssueSearch("is:closed crash").state).toBe("closed");
  expect(parseIssueSearch('"is:open" -is:closed').state).toBeUndefined();
  expect(parseIssueSearch('label:"is:open" author:octocat').state).toBeUndefined();
  expect(parseIssueSearch("state:closed").state).toBe("closed");
  expect(parseIssueSearch('label:"needs review" label:bug author:"octocat"')).toMatchObject({
    labels: ["needs review", "bug"],
    author: "octocat",
  });
});
