import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("061_ProjectionThreadIssues", (it) => {
  it.effect(
    "indexes V2 issue links and preserves closed state when upgrading an existing projection",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        const payload = encodeJson({
          issues: [
            {
              host: "GITHUB.COM",
              repository: "Owner/Repo",
              number: 5,
              url: "https://github.com/owner/repo/issues/5",
              linkedAt: "2026-10-01T00:00:00Z",
              snapshot: { title: "Fix it", state: "closed", updatedAt: "2026-10-02T00:00:00Z" },
            },
          ],
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('thread:migrated', 'project:web', 'Migrated', 'codex', 'codex', 'full-access', 'default', '2026-10-01', '2026-10-02', ${payload})`;
        yield* runMigrations();
        const rows =
          yield* sql`SELECT thread_id, host, repository, number, json_extract(snapshot_json, '$.state') AS state FROM orchestration_v2_projection_thread_issues`;
        assert.deepStrictEqual(rows, [
          {
            thread_id: "thread:migrated",
            host: "github.com",
            repository: "owner/repo",
            number: 5,
            state: "closed",
          },
        ]);
        yield* runMigrations();
        assert.equal(
          (yield* sql`SELECT * FROM orchestration_v2_projection_thread_issues`).length,
          1,
        );
      }),
  );
});
