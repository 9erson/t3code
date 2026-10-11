import { EnvironmentId, ProjectId, type IssueListResult } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { writeIssueListSnapshot } from "../components/issue/issueListPreferences";
import { useIssueList } from "./issues";

const live = vi.hoisted(() => ({
  query: {
    values: [] as Array<readonly [EnvironmentId, IssueListResult]>,
    errors: [],
    isPending: true,
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => live.query,
}));

const environmentId = EnvironmentId.make("saved-environment");
const targets = [{ environmentId, input: { state: "closed" as const, limit: 100 } }];
const saved: IssueListResult = {
  viewers: { "github.com": "alice" },
  providers: [],
  errors: [],
  truncated: true,
  nextCursors: { "github.com acme/web": "2:0" },
  entries: [
    {
      provider: "github",
      host: "github.com",
      repository: "acme/web",
      projectId: ProjectId.make("web"),
      projectTitle: "Web",
      number: 7,
      title: "Saved issue",
      url: "https://github.com/acme/web/issues/7",
      author: null,
      state: "closed",
      labels: [],
      assignees: [],
      commentCount: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
    },
  ],
};

type ListView = ReturnType<typeof useIssueList>;
function Probe({ onPaint }: { onPaint: (view: ListView) => void }) {
  const view = useIssueList(targets);
  onPaint(view);
  return <p>{view.data?.entries[0]?.title ?? "Loading"}</p>;
}
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("paints saved rows on the first render while revalidating, then replaces them and restores the fresh list on reload", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage });
  writeIssueListSnapshot(JSON.stringify(targets), [[environmentId, saved]], localStorage);
  live.query = { values: [], errors: [], isPending: true };
  const paints: ListView[] = [];
  const element = <Probe onPaint={(view) => paints.push(view)} />;
  act(() => {
    renderer = create(element);
  });
  expect(paints[0]?.data?.entries[0]?.title).toBe("Saved issue");
  expect(paints[0]).toMatchObject({ showingSnapshot: true, isPending: true, canLoadMore: false });

  live.query = {
    errors: [],
    isPending: false,
    values: [
      [
        environmentId,
        {
          ...saved,
          entries: saved.entries.map((entry) => ({ ...entry, title: "Fresh issue" })),
        },
      ],
    ],
  };
  act(() => {
    renderer?.update(<Probe onPaint={(view) => paints.push(view)} />);
  });
  expect(paints.at(-1)?.data?.entries.map((entry) => entry.title)).toEqual(["Fresh issue"]);
  expect(paints.at(-1)).toMatchObject({
    showingSnapshot: false,
    isPending: false,
    canLoadMore: true,
  });

  act(() => renderer?.unmount());
  live.query = { values: [], errors: [], isPending: true };
  paints.length = 0;
  act(() => {
    renderer = create(element);
  });
  expect(paints[0]?.data?.entries[0]?.title).toBe("Fresh issue");
  expect(paints[0]?.showingSnapshot).toBe(true);
});
