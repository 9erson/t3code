import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  clearIssueSelectionSearch,
  issueSelectionFromSearch,
  issueSelectionSearch,
} from "./issueSelection.logic";

it("restores issue selection from URL search independently of the issue list", () => {
  const selection = {
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project"),
    host: "ghe.example",
    repository: "acme/web",
    number: 42,
  };
  expect(issueSelectionFromSearch({ state: "closed", ...issueSelectionSearch(selection) })).toEqual(
    selection,
  );
  expect(
    issueSelectionFromSearch({
      selectedEnvironmentId: EnvironmentId.make("remote"),
      selectedProjectId: ProjectId.make("project"),
      selectedHost: "ghe.example",
      repository: "acme/web",
      number: "42",
    }),
  ).toEqual(selection);
});

it("ignores incomplete or invalid selections and removes selection when closed", () => {
  const params = {
    selectedEnvironmentId: EnvironmentId.make("remote"),
    selectedProjectId: ProjectId.make("project"),
    selectedHost: "github.com",
    repository: "acme/web",
    number: 42,
  };
  for (const number of [0, -1, 1.5, "no", Infinity])
    expect(issueSelectionFromSearch({ ...params, number })).toBeNull();
  expect(issueSelectionFromSearch({ repository: "acme/web", number: 42 })).toBeNull();
  const closed = clearIssueSelectionSearch({ ...params, state: "closed" as const, q: "label:bug" });
  expect(closed).toEqual({ state: "closed", q: "label:bug" });
  expect(issueSelectionFromSearch(closed)).toBeNull();
});
