import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore, MAX_PAGE_DEPTH } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う
const OWNER = "synthetic-folder-owner-a";
const OTHER = "synthetic-folder-owner-b";
const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];

/**
 * フォルダ＝親ページの運用規則（docs/architecture/editor-recipes-and-folders.md §3）を実 PostgreSQL で確かめる。
 * 段は フォルダ（0）› ページ（1）› 録音のサブページ（2）まで。入れる・出すでページは失われない。
 */
describe("folders are pages with children (pages.parent)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_folders_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM pages WHERE owner = ANY($1::text[])", [[OWNER, OTHER]]);
  });

  const page = async (title: string, owner = OWNER) => (await store.createPage(owner, { title, blocks })).id;

  /** 読めるページの id と親（ゴミ箱は含まない）。 */
  async function tree(owner = OWNER): Promise<[string, string | null][]> {
    return (await store.listPages(owner)).map((item) => [item.title, item.parent]);
  }

  it("puts a page into a folder and takes it out again, without losing a page", async () => {
    const folder = await page("鎌倉の記事");
    const note = await page("取材メモ");
    assert.deepEqual((await tree()).length, 2);

    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    const inside = await tree();
    assert.equal(inside.length, 2, "フォルダに入れてもページは減らない");
    assert.deepEqual(
      inside.find(([title]) => title === "取材メモ"),
      ["取材メモ", folder],
    );

    assert.equal(await store.movePage(OWNER, note, null), "moved");
    const outside = await tree();
    assert.equal(outside.length, 2, "フォルダから出してもページは減らない");
    assert.deepEqual(
      outside.find(([title]) => title === "取材メモ"),
      ["取材メモ", null],
    );
  });

  it("allows フォルダ › ページ › 録音のサブページ and refuses one more 段", async () => {
    const folder = await page("フォルダ");
    const note = await page("ページ");
    const sub = await page("録音のサブページ");
    const deeper = await page("その下");
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    assert.equal(await store.movePage(OWNER, sub, note), "moved");
    assert.equal(MAX_PAGE_DEPTH, 2);

    assert.equal(await store.movePage(OWNER, deeper, sub), "too_deep");
    // 断られた移動は何も書かない
    assert.equal((await store.getPage(OWNER, deeper))?.parent, null);
    assert.equal((await tree()).length, 4);
  });

  it("refuses to put a folder that already has 段 under another folder", async () => {
    const outer = await page("外のフォルダ");
    const folder = await page("中のフォルダ");
    const note = await page("ページ");
    const sub = await page("サブページ");
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    assert.equal(await store.movePage(OWNER, sub, note), "moved");

    // folder の下は 2 段あるので、さらに入れると 3 段になる
    assert.equal(await store.movePage(OWNER, folder, outer), "too_deep");
    assert.equal((await store.getPage(OWNER, folder))?.parent, null);

    // 1 段だけのフォルダは入る
    assert.equal(await store.movePage(OWNER, sub, null), "moved");
    assert.equal(await store.movePage(OWNER, folder, outer), "moved");
  });

  it("refuses a move into itself or into its own 子孫", async () => {
    const folder = await page("フォルダ");
    const note = await page("ページ");
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    assert.equal(await store.movePage(OWNER, folder, folder), "cycle");
    assert.equal(await store.movePage(OWNER, folder, note), "cycle");
    assert.equal((await store.getPage(OWNER, folder))?.parent, null);
    assert.equal((await store.getPage(OWNER, note))?.parent, folder);
  });

  it("answers the same 404 for another person's page, a trashed page and an id that is not a page", async () => {
    const mine = await page("自分のページ");
    const theirs = await page("別の人のページ", OTHER);
    const trashed = await page("ゴミ箱のフォルダ");
    assert.equal(await store.deletePage(OWNER, trashed), "deleted");

    // 入れ先が別の人のもの・ゴミ箱の中・無い id
    assert.equal(await store.movePage(OWNER, mine, theirs), null);
    assert.equal(await store.movePage(OWNER, mine, trashed), null);
    assert.equal(await store.movePage(OWNER, mine, randomUUID()), null);
    assert.equal(await store.movePage(OWNER, mine, "not-a-uuid"), null);
    // 動かすページが別の人のもの・無い id
    assert.equal(await store.movePage(OTHER, mine, null), null);
    assert.equal(await store.movePage(OWNER, randomUUID(), null), null);
    assert.equal((await store.getPage(OWNER, mine))?.parent, null);
  });

  it("changes only the parent: the body, the revision and the 時刻 stay as they are", async () => {
    const folder = await page("フォルダ");
    const note = await page("ページ");
    const before = await store.getPage(OWNER, note);
    assert.ok(before);
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    const after = await store.getPage(OWNER, note);
    assert.deepEqual({ ...after, parent: null }, { ...before, parent: null });
    assert.equal(after?.parent, folder);
    // 同じ入れ先へもう一度は何もしない
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
  });

  it("keeps the children with the folder in the trash, and brings them back together", async () => {
    const folder = await page("フォルダ");
    const note = await page("ページ");
    const sub = await page("サブページ");
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    assert.equal(await store.movePage(OWNER, sub, note), "moved");

    assert.equal(await store.deletePage(OWNER, folder), "deleted");
    assert.deepEqual(await tree(), []);
    assert.deepEqual((await store.listTrash(OWNER)).map((item) => item.title).sort(), ["サブページ", "フォルダ", "ページ"]);

    assert.equal(await store.restoreFromTrash(OWNER, folder), true);
    assert.deepEqual((await tree()).sort(), [
      ["サブページ", note],
      ["フォルダ", null],
      ["ページ", folder],
    ]);
  });
});
