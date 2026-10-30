import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { SHARE_TOKEN_PATTERN, enableShare, getShare, readSharedPage, rotateShare, stopShare, type PageShareState } from "../src/shares.ts";
import type { Queryable } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-share-owner-a";
const OTHER = "synthetic-share-owner-b";

type Node = { readonly [key: string]: unknown };
const paragraph = (value: string): Node => ({ type: "paragraph", content: [{ type: "text", text: value }] });

async function newPool(schema: string): Promise<PgPool> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = await newPool(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

/** store を通さずに行を入れる（0002 以降の列は既定値に任せる）。 */
async function insertPage(pool: PgPool, seed: { owner?: string; title?: string; blocks?: Node[]; deleted?: boolean } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pages (owner, title, blocks, deleted_at)
     VALUES ($1, $2, $3::jsonb, CASE WHEN $4::boolean THEN clock_timestamp() END)
     RETURNING id`,
    [seed.owner ?? OWNER, seed.title ?? "", JSON.stringify(seed.blocks ?? []), seed.deleted ?? false],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

function tokenOf(state: PageShareState | null): string {
  assert.ok(state?.shared, "the page is shared");
  return state.token;
}

async function shareRows(pool: PgPool): Promise<Array<{ page_id: string; owner: string; token: string }>> {
  return (await pool.query<{ page_id: string; owner: string; token: string }>("SELECT page_id, owner, token FROM page_shares ORDER BY page_id")).rows;
}

describe("0004 on a database that only has 0001 and 0003", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("shares0004"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0004-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds page_shares next to existing pages without touching them, and the pages can be shared afterwards", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    for (const name of ["0001_editor_store.sql", "0003_search_text.sql"]) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, ["0001_editor_store.sql", "0003_search_text.sql"]);
      const page = await insertPage(pool, { title: "前からあるページ", blocks: [paragraph("前からある本文")] });
      const before = (await pool.query("SELECT * FROM pages WHERE id = $1", [page])).rows[0];

      await copyFile(join(migrations, "0004_page_shares.sql"), join(dir, "0004_page_shares.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0004_page_shares.sql"]);
      assert.deepEqual(second.skipped, ["0001_editor_store.sql", "0003_search_text.sql"]);

      assert.deepEqual((await pool.query("SELECT * FROM pages WHERE id = $1", [page])).rows[0], before, "existing rows are unchanged");
      assert.deepEqual(await shareRows(pool), [], "nothing is shared by the migration");
      const token = tokenOf(await enableShare(pool, OWNER, page));
      const shared = await readSharedPage(pool, token);
      assert.equal(shared?.title, "前からあるページ");
      assert.deepEqual(shared?.blocks, [paragraph("前からある本文")]);
    } finally {
      client.release();
    }
  });
});

describe("page shares on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("shares"));
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await drop();
  });

  it("starts sharing once: enable is idempotent and gives a 43-character URL-safe token", async () => {
    const page = await insertPage(pool, { title: "共有する", blocks: [paragraph("共有の本文")] });
    assert.deepEqual(await getShare(pool, OWNER, page), { shared: false });

    const first = await enableShare(pool, OWNER, page);
    const token = tokenOf(first);
    assert.match(token, SHARE_TOKEN_PATTERN);
    assert.equal(token.length, 43);
    assert.equal(first?.shared && first.rotatedAt, null);

    const again = await enableShare(pool, OWNER, page);
    assert.deepEqual(again, first, "the same token and times on the second enable");
    assert.deepEqual(await getShare(pool, OWNER, page), first);
    assert.equal((await shareRows(pool)).filter((row) => row.page_id === page).length, 1);
  });

  it("returns one token to two enables that race", async () => {
    const page = await insertPage(pool, { title: "同時" });
    const [a, b] = await Promise.all([enableShare(pool, OWNER, page), enableShare(pool, OWNER, page)]);
    assert.equal(tokenOf(a), tokenOf(b));
  });

  it("reads back only the title, language, blocks, and update time of the latest saved version", async () => {
    const page = await insertPage(pool, { title: "最新", blocks: [paragraph("最初の本文")] });
    const token = tokenOf(await enableShare(pool, OWNER, page));
    const first = await readSharedPage(pool, token);
    assert.ok(first);
    assert.deepEqual(Object.keys(first).sort(), ["blocks", "lang", "title", "updatedAt"]);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(`${page}|${OWNER}|${token}|"kind"|"note"`));
    assert.deepEqual(first.blocks, [paragraph("最初の本文")]);

    // 共有中に本文を保存し直すと、次の読み取りは新しい保存内容（共有の行に本文を写していない）
    await pool.query("UPDATE pages SET title = $2, blocks = $3::jsonb, updated_at = clock_timestamp() WHERE id = $1", [
      page,
      "直した題名",
      JSON.stringify([paragraph("直した本文")]),
    ]);
    const second = await readSharedPage(pool, token);
    assert.equal(second?.title, "直した題名");
    assert.deepEqual(second?.blocks, [paragraph("直した本文")]);
    assert.ok(Date.parse(second!.updatedAt) >= Date.parse(first.updatedAt));
  });

  it("rotates to a new token: the old one stops working at once and the new one works", async () => {
    const page = await insertPage(pool, { title: "作り直す", blocks: [paragraph("作り直しの本文")] });
    const before = await enableShare(pool, OWNER, page);
    const old = tokenOf(before);
    const rotated = await rotateShare(pool, OWNER, page);
    const fresh = tokenOf(rotated);
    assert.notEqual(fresh, old);
    assert.match(fresh, SHARE_TOKEN_PATTERN);
    assert.ok(rotated?.shared && rotated.rotatedAt !== null && before?.shared && rotated.createdAt === before.createdAt);
    assert.equal(await readSharedPage(pool, old), null, "the old link is gone");
    assert.equal((await readSharedPage(pool, fresh))?.title, "作り直す");
    assert.deepEqual(await getShare(pool, OWNER, page), rotated);
  });

  it("rotating a page that is not shared starts sharing it", async () => {
    const page = await insertPage(pool, { title: "未共有" });
    const state = await rotateShare(pool, OWNER, page);
    assert.ok(state?.shared);
    assert.equal(state.rotatedAt, null, "nothing was rotated");
    assert.equal((await readSharedPage(pool, state.token))?.title, "未共有");
  });

  it("stops sharing at once and stays stopped; sharing again gives a new token", async () => {
    const page = await insertPage(pool, { title: "止める", blocks: [paragraph("止める本文")] });
    const token = tokenOf(await enableShare(pool, OWNER, page));
    assert.ok(await readSharedPage(pool, token));
    assert.deepEqual(await stopShare(pool, OWNER, page), { shared: false });
    assert.equal(await readSharedPage(pool, token), null, "the link is gone as soon as it is stopped");
    assert.deepEqual(await getShare(pool, OWNER, page), { shared: false });
    assert.deepEqual(await stopShare(pool, OWNER, page), { shared: false }, "stop is idempotent");
    const again = tokenOf(await enableShare(pool, OWNER, page));
    assert.notEqual(again, token);
    assert.equal(await readSharedPage(pool, token), null);
  });

  it("answers null to another owner's page and changes nothing", async () => {
    const theirs = await insertPage(pool, { owner: OTHER, title: "他人のページ" });
    const theirToken = tokenOf(await enableShare(pool, OTHER, theirs));
    const rowsBefore = await shareRows(pool);
    assert.equal(await getShare(pool, OWNER, theirs), null);
    assert.equal(await enableShare(pool, OWNER, theirs), null);
    assert.equal(await rotateShare(pool, OWNER, theirs), null);
    assert.equal(await stopShare(pool, OWNER, theirs), null);
    assert.deepEqual(await shareRows(pool), rowsBefore, "no share row was added, rotated, or removed");
    assert.equal((await readSharedPage(pool, theirToken))?.title, "他人のページ");

    // 存在しない id も同じ null
    for (const id of [randomUUID(), "00000000-0000-0000-0000-00000000000g"]) {
      assert.equal(await getShare(pool, OWNER, id), null);
      assert.equal(await enableShare(pool, OWNER, id), null);
      assert.equal(await rotateShare(pool, OWNER, id), null);
      assert.equal(await stopShare(pool, OWNER, id), null);
    }
  });

  it("does not show a page in the trash, and cannot share one", async () => {
    const page = await insertPage(pool, { title: "ゴミ箱へ" });
    const token = tokenOf(await enableShare(pool, OWNER, page));
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [page]);
    assert.equal(await readSharedPage(pool, token), null);
    assert.equal(await getShare(pool, OWNER, page), null);
    assert.equal(await enableShare(pool, OWNER, page), null);
    assert.equal(await rotateShare(pool, OWNER, page), null);
    assert.equal(await stopShare(pool, OWNER, page), null);

    const removed = await insertPage(pool, { title: "最初から削除済み", deleted: true });
    assert.equal(await enableShare(pool, OWNER, removed), null);
    assert.equal((await pool.query("SELECT 1 FROM page_shares WHERE page_id = $1", [removed])).rowCount, 0);
  });

  it("stops sharing when the page goes to the trash, and restoring it does not share it again", async () => {
    const page = await insertPage(pool, { title: "戻しても共有しない" });
    const token = tokenOf(await enableShare(pool, OWNER, page));
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [page]);
    assert.equal((await pool.query("SELECT 1 FROM page_shares WHERE page_id = $1", [page])).rowCount, 0);
    await pool.query("UPDATE pages SET deleted_at = NULL WHERE id = $1", [page]);
    assert.equal(await readSharedPage(pool, token), null);
    assert.deepEqual(await getShare(pool, OWNER, page), { shared: false });

    // ゴミ箱に関わらない更新（題名を直す）では、共有は続く
    const other = await insertPage(pool, { title: "題名を直しても共有は続く" });
    const otherToken = tokenOf(await enableShare(pool, OWNER, other));
    await pool.query("UPDATE pages SET title = '直した' WHERE id = $1", [other]);
    assert.equal((await readSharedPage(pool, otherToken))?.title, "直した");
  });

  it("removes the share row when the page itself is deleted", async () => {
    const page = await insertPage(pool, { title: "消す" });
    const token = tokenOf(await enableShare(pool, OWNER, page));
    await pool.query("DELETE FROM pages WHERE id = $1", [page]);
    assert.equal((await pool.query("SELECT 1 FROM page_shares WHERE page_id = $1", [page])).rowCount, 0);
    assert.equal(await readSharedPage(pool, token), null);
  });

  it("keeps the table's invariants when the code is bypassed", async () => {
    const page = await insertPage(pool, { title: "制約" });
    const theirs = await insertPage(pool, { owner: OTHER });
    const valid = "C".repeat(43);
    // 形の違う token・別の owner のページへの共有・同じ token の 2 回目は入らない
    await assert.rejects(() => pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, 'short')", [page, OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, $3)", [theirs, OWNER, valid]), { code: "23503" });
    await pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, $3)", [page, OWNER, valid]);
    await assert.rejects(() => pool.query("INSERT INTO page_shares (page_id, owner, token) VALUES ($1, $2, $3)", [theirs, OTHER, valid]), { code: "23505" });
    await assert.rejects(() => pool.query("UPDATE page_shares SET rotated_at = created_at - interval '1 second' WHERE page_id = $1", [page]), { code: "23514" });
  });

  it("asks the database only once for a well-formed token", async () => {
    const calls: string[] = [];
    const counting: Queryable = {
      query: ((sql: string, values?: unknown[]) => {
        calls.push(sql);
        return pool.query(sql, values);
      }) as unknown as Queryable["query"],
    };
    assert.equal(await readSharedPage(counting, "D".repeat(43)), null);
    assert.equal(await readSharedPage(counting, "D".repeat(42)), null);
    assert.equal(calls.length, 1);
  });
});
