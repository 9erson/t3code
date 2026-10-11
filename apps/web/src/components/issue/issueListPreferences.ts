import {
  EnvironmentId,
  ProjectId,
  IssueListState,
  IssueListSort,
  IssueListResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Bounded = Schema.String.check(Schema.isMaxLength(256));
const Preferences = Schema.Struct({
  state: IssueListState,
  issueInvolvement: Schema.Literals(["all", "assigned", "authored", "others"]),
  issueSort: IssueListSort,
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  host: Schema.optional(Bounded),
  q: Schema.optional(Bounded),
  author: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
  labels: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(10)),
  ),
});
export interface IssueListPreferences {
  readonly state: IssueListState;
  readonly issueInvolvement: "all" | "assigned" | "authored" | "others";
  readonly issueSort: IssueListSort;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly q?: string;
  readonly author?: string;
  readonly labels?: ReadonlyArray<string>;
}
function listPreferences(value: typeof Preferences.Type): IssueListPreferences {
  return {
    state: value.state,
    issueInvolvement: value.issueInvolvement,
    issueSort: value.issueSort,
    ...(value.environmentId ? { environmentId: value.environmentId } : {}),
    ...(value.projectId ? { projectId: value.projectId } : {}),
    ...(value.host ? { host: value.host } : {}),
    ...(value.q ? { q: value.q } : {}),
    ...(value.author ? { author: value.author } : {}),
    ...(value.labels?.length ? { labels: value.labels } : {}),
  };
}
export type IssueListPreferencePatch = {
  [K in keyof IssueListPreferences]?: IssueListPreferences[K] | undefined;
};
const defaults: IssueListPreferences = {
  state: "open",
  issueInvolvement: "all",
  issueSort: "updated",
};
const decode = Schema.decodeUnknownOption(Preferences);
type ListStorage = Pick<Storage, "getItem" | "setItem">;
const storageOf = (storage?: ListStorage) =>
  storage ?? (typeof window === "undefined" ? undefined : window.localStorage);

/** An explicit URL is a complete scope; saved choices are used only for an unscoped visit. */
export function validateIssueListSearch(
  search: Record<string, unknown>,
  saved = defaults,
): IssueListPreferences {
  if (!Object.keys(Preferences.fields).some((key) => Object.hasOwn(search, key))) return saved;
  const result = decode({ ...defaults, ...search });
  return result._tag === "Some" ? listPreferences(result.value) : defaults;
}
export function readIssueListPreferences(storage?: ListStorage): IssueListPreferences {
  try {
    const raw = storageOf(storage)?.getItem("t3.issues.preferences");
    if (!raw) return defaults;
    const result = decode(JSON.parse(raw));
    return result._tag === "Some" ? listPreferences(result.value) : defaults;
  } catch {
    return defaults;
  }
}
export function writeIssueListPreferences(
  value: IssueListPreferences,
  storage?: ListStorage,
): void {
  try {
    storageOf(storage)?.setItem("t3.issues.preferences", JSON.stringify(listPreferences(value)));
  } catch {
    /* The URL still works when storage is denied. */
  }
}

const Snapshot = Schema.Struct({
  key: Schema.String,
  values: Schema.Array(Schema.Tuple([EnvironmentId, IssueListResult])).check(
    Schema.isMaxLength(100),
  ),
});
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot);
export function readIssueListSnapshot(
  key: string,
  storage?: ListStorage,
): ReadonlyArray<readonly [EnvironmentId, IssueListResult]> | null {
  try {
    const raw = storageOf(storage)?.getItem("t3.issues.list");
    if (!raw) return null;
    const result = decodeSnapshot(JSON.parse(raw));
    return result._tag === "Some" && result.value.key === key ? result.value.values : null;
  } catch {
    return null;
  }
}
/** Only enough rows for a warm first paint are saved; live cursors always come from revalidation. */
export function writeIssueListSnapshot(
  key: string,
  values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  storage?: ListStorage,
): void {
  try {
    let remaining = 100;
    const bounded = values.slice(0, 100).map(([environmentId, result]) => {
      const entries = result.entries.slice(0, remaining);
      remaining -= entries.length;
      return [environmentId, { ...result, entries, errors: [], nextCursors: {}, truncated: false }];
    });
    storageOf(storage)?.setItem("t3.issues.list", JSON.stringify({ key, values: bounded }));
  } catch {
    /* A snapshot is optional when storage is denied or full. */
  }
}
