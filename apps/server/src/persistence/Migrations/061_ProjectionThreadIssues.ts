import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_thread_issues (
    thread_id TEXT NOT NULL REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
    host TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
    url TEXT NOT NULL, linked_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, host, repository, number)
  )`;
  yield* sql`CREATE INDEX orchestration_v2_projection_thread_issues_identity_idx
    ON orchestration_v2_projection_thread_issues(host, repository, number)`;
  yield* sql`INSERT INTO orchestration_v2_projection_thread_issues
    SELECT t.thread_id, lower(json_extract(i.value, '$.host')), lower(json_extract(i.value, '$.repository')),
      json_extract(i.value, '$.number'), json_extract(i.value, '$.url'),
      json_extract(i.value, '$.linkedAt'), json_extract(i.value, '$.snapshot')
    FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.issues') i
    WHERE t.deleted_at IS NULL`;
});
