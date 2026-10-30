import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { MIGRATIONS_TABLE, applyMigrations, readMigrations } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";
import type { Page, SaveResult } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";

function expectSaved(result: SaveResult | null): Page {
  assert.ok(result !== null && result.status === "saved", `expected a save, got ${result === null ? "null" : result.status}`);
  return result.page;
}

describe("PostgreSQL editor store", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_test_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  async function newPool(): Promise<PgPool> {
    const { Pool } = await import("pg");
    return new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  }

  before(async () => {
    pool = await newPool();
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("applies every migration to an empty schema once and creates exactly the four tables without rows", async () => {
    const client = await pool.connect();
    try {
      const names = (await readMigrations()).map((file) => file.name);
      const first = await applyMigrations(client);
      assert.deepEqual(first.applied, names);
      const second = await applyMigrations(client);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, names);
    } finally {
      client.release();
    }
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    // ai_usage は AI の使用量（0005。ページの表とは別）
    assert.deepEqual(tables.rows.map((row) => row.table_name), ["ai_usage", "assets", MIGRATIONS_TABLE, "page_versions", "pages", "publications"].sort());
    for (const table of ["pages", "page_versions", "assets", "publications", "ai_usage"]) {
      const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      assert.equal(count.rows[0]?.n, "0", `${table} must be empty after migration`);
    }
    const index = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'pages_owner_updated_idx'",
      [schema],
    );
    assert.match(index.rows[0]?.indexdef ?? "", /\(owner, updated_at DESC\) WHERE \(deleted_at IS NULL\)/);
  });

  it("refuses a migration that was edited after it was applied", async () => {
    const client = await pool.connect();
    try {
      await client.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $1 WHERE name = '0001_editor_store.sql'`, ["0".repeat(64)]);
      await assert.rejects(() => applyMigrations(client), /changed after it was applied/);
    } finally {
      const [file] = await readMigrations();
      await client.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $1 WHERE name = '0001_editor_store.sql'`, [file?.checksum]);
      client.release();
    }
  });

  it("creates an empty page, saves it, and reads it back from a new connection", async () => {
    const store = new EditorStore(pool);
    const created = await store.createPage(OWNER);
    assert.equal(created.title, "");
    assert.deepEqual(created.blocks, []);
    assert.equal(created.kind, "note");
    assert.equal(created.lang, "ja");

    assert.equal(created.revision, 1);

    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    const saved = expectSaved(await store.savePage(OWNER, created.id, { title: "合成の題名", blocks }, { baseRevision: created.revision }));
    assert.ok(Date.parse(saved.updatedAt) >= Date.parse(created.updatedAt));
    assert.equal(saved.revision, 2, "every save bumps the revision");

    const again = expectSaved(await store.savePage(OWNER, created.id, { lang: "en" }, { baseRevision: saved.revision }));
    assert.equal(again.title, "合成の題名", "a partial patch keeps the other fields");
    assert.ok(Date.parse(again.updatedAt) >= Date.parse(saved.updatedAt));
    assert.equal(again.revision, 3);

    const otherPool = await newPool();
    try {
      const read = await new EditorStore(otherPool).getPage(OWNER, created.id);
      assert.ok(read);
      assert.equal(read.title, "合成の題名");
      assert.equal(read.lang, "en");
      assert.deepEqual(read.blocks, blocks);
      assert.equal(read.revision, 3);
    } finally {
      await otherPool.end();
    }
  });

  it("hides pages of another owner, deleted pages, unknown ids, and malformed ids alike", async () => {
    const store = new EditorStore(pool);
    const mine = await store.createPage(OWNER, { title: "mine" });
    const theirs = await store.createPage(OTHER, { title: "theirs" });
    const removed = await store.createPage(OWNER, { title: "removed" });
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [removed.id]);

    for (const id of [theirs.id, removed.id, randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-00000000000g"]) {
      assert.equal(await store.getPage(OWNER, id), null, id);
      assert.equal(await store.savePage(OWNER, id, { title: "overwrite" }, { baseRevision: 1 }), null, id);
      assert.equal(await store.savePage(OWNER, id, { title: "overwrite" }, { baseRevision: 99 }), null, `${id} is missing, not in conflict`);
    }
    const untouched = await store.getPage(OTHER, theirs.id);
    assert.equal(untouched?.title, "theirs", "another owner's page is not changed");

    const list = await store.listPages(OWNER);
    const ids = list.map((page) => page.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(theirs.id));
    assert.ok(!ids.includes(removed.id));
    for (let index = 1; index < list.length; index++) {
      assert.ok(Date.parse(list[index - 1]!.updatedAt) >= Date.parse(list[index]!.updatedAt), "list is newest first");
    }
  });

  it("keeps the database invariants even when the store is bypassed", async () => {
    const page = await new EditorStore(pool).createPage(OWNER);
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, blocks) VALUES ($1, '{}'::jsonb)", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, kind) VALUES ($1, 'html')", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, lang) VALUES ($1, 'fr')", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, step_status) VALUES ($1, 'paused')", [OWNER]), { code: "23514" });
    // 別の owner のページを親にはできない
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, parent) VALUES ($1, $2)", [OTHER, page.id]), { code: "23503" });
    await assert.rejects(
      () => pool.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, '[]', 'manual')", [page.id]),
      { code: "23514" },
    );
    await assert.rejects(
      () => pool.query(
        "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', 'a/b.png', 1, $3, 'image/png')",
        [OTHER, page.id, "a".repeat(64)],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      () => pool.query(
        "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', 'https://example.com/a.png', 1, $3, 'image/png')",
        [OWNER, page.id, "a".repeat(64)],
      ),
      { code: "23514" },
    );
  });
});
