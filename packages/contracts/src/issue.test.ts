import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { IssueListInput, IssueListResult } from "./issue.ts";

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
