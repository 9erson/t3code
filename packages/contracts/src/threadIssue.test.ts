import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { IssueLinkInput, ThreadIssueLink } from "./threadIssue.ts";

const decodeLink = Schema.decodeUnknownSync(ThreadIssueLink);
const encodeLink = Schema.encodeSync(ThreadIssueLink);
const decodeInput = Schema.decodeUnknownSync(IssueLinkInput);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

it("round-trips closed issue links and bounds issue identities", () => {
  const link: ThreadIssueLink = {
    host: "github.com",
    repository: "owner/repo",
    number: 5,
    url: "https://github.com/owner/repo/issues/5",
    linkedAt: "2026-10-01T00:00:00Z",
    snapshot: { title: "Fix it", state: "closed", updatedAt: "2026-10-02T00:00:00Z" },
  };
  expect(decodeLink(encodeLink(link))).toEqual(link);
  for (const number of [0, -1, 1.5])
    expect(() =>
      decodeInput({
        threadId: "t",
        host: "github.com",
        repository: "owner/repo",
        number,
      }),
    ).toThrow();
});
it("keeps issue mutation and synchronization commands off generic client dispatch", () => {
  for (const type of ["thread.issue.link", "thread.issue.unlink", "thread.issue.sync"]) {
    expect(() =>
      decodeCommand({
        type,
        threadId: ThreadId.make("t"),
        commandId: CommandId.make("c"),
        host: "github.com",
        repository: "owner/repo",
        number: 5,
        url: "https://github.com/owner/repo/issues/5",
        snapshot: { title: "Fix it", state: "open", updatedAt: "2026-10-01T00:00:00Z" },
      }),
    ).toThrow();
  }
});
