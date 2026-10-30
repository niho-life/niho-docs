import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { MIGRATION_FILE_PATTERN, migrationBody, readMigrations } from "../src/migrate.ts";
import { EditorStore, isPageId } from "../src/store.ts";
import type { Queryable } from "../src/types.ts";

const TABLES = ["pages", "page_versions", "assets", "publications"] as const;

/** SQL の行コメントを除いた本文（列の名前の検査をコメントの言葉で誤らないように）。 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function tableBody(sql: string, table: string): string {
  return sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
}

describe("migration files", () => {
  it("are numbered, unique, sorted .sql files wrapped in one transaction", async () => {
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => !name.startsWith("."));
    assert.ok(names.length > 0);
    for (const name of names) assert.match(name, MIGRATION_FILE_PATTERN, `${name} does not follow NNNN_name.sql`);
    const prefixes = names.map((name) => name.slice(0, 4));
    assert.equal(new Set(prefixes).size, prefixes.length, "migration numbers must be unique");
    const files = await readMigrations();
    assert.deepEqual(files.map((file) => file.name), [...names].sort());
    for (const file of files) assert.doesNotThrow(() => migrationBody(file));
  });

  it("refuses a migration that is not wrapped in BEGIN/COMMIT", () => {
    assert.throws(() => migrationBody({ name: "0099_bad.sql", sql: "CREATE TABLE x (id int);\n" }), /BEGIN/);
  });

  it("declares the four tables with the documented columns and checks", async () => {
    const [first] = await readMigrations();
    assert.ok(first);
    const sql = withoutComments(first.sql);
    for (const table of TABLES) assert.ok(tableBody(sql, table).length > 0, `missing table ${table}`);

    const pages = tableBody(sql, "pages");
    for (const column of ["id uuid PRIMARY KEY DEFAULT gen_random_uuid()", "owner text NOT NULL", "kind text", "title text", "lang text", "blocks jsonb", "cover uuid", "lead text", "parent uuid", "recipe text", "step_status text", "created_at timestamptz", "updated_at timestamptz", "deleted_at timestamptz"]) {
      assert.ok(pages.includes(column), `pages.${column}`);
    }
    assert.match(pages, /kind IN \('note', 'journal', 'rec', 'article', 'step'\)/);
    assert.match(pages, /lang IN \('ja', 'en'\)/);
    assert.match(pages, /step_status IN \('done', 'run', 'wait', 'stale'\)/);
    assert.match(pages, /jsonb_typeof\(blocks\) = 'array'/);
    assert.match(pages, /FOREIGN KEY \(owner, parent\) REFERENCES pages \(owner, id\)/);
    assert.match(sql, /CREATE INDEX pages_owner_updated_idx\s+ON pages \(owner, updated_at DESC\)\s+WHERE deleted_at IS NULL;/);

    const versions = tableBody(sql, "page_versions");
    assert.match(versions, /reason IN \('autosave', 'ai', 'publish'\)/);
    assert.match(versions, /PRIMARY KEY \(page_id, version\)/);

    const assets = tableBody(sql, "assets");
    for (const column of ["id uuid", "owner text", "page_id uuid", "kind text", "bucket_path text", "bytes bigint", "sha256 text", "content_type text", "alt text", "credit text", "consent boolean"]) {
      assert.ok(assets.includes(column), `assets.${column}`);
    }
    assert.match(assets, /kind IN \('image', 'audio'\)/);
    assert.match(assets, /FOREIGN KEY \(owner, page_id\) REFERENCES pages \(owner, id\)/);

    const publications = tableBody(sql, "publications");
    for (const column of ["page_id uuid PRIMARY KEY", "dest text", "slug text", "range text", "published_version integer", "category text", "related jsonb", "extras jsonb", "published_at timestamptz", "stopped_at timestamptz"]) {
      assert.ok(publications.includes(column), `publications.${column}`);
    }
    assert.match(publications, /range IN \('live', 'unlisted'\)/);
    assert.match(publications, /UNIQUE \(dest, slug\)/);
  });

  it("contains no records, secrets, credentials, real addresses, or token columns", async () => {
    for (const file of await readMigrations()) {
      const sql = file.sql;
      assert.doesNotMatch(sql, /\bINSERT\s+INTO\b|\bCOPY\b/i, `${file.name} must not carry records`);
      assert.doesNotMatch(sql, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      assert.doesNotMatch(sql, /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "credential URL");
      assert.doesNotMatch(sql, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "e-mail address");
      assert.doesNotMatch(sql, /\/Users\/|\/home\//, "absolute user path");
      const columns = withoutComments(sql);
      assert.doesNotMatch(columns, /\b(email|password|secret|token|cookie|access_key)\w*\s+(text|bytea|jsonb)/i, "secret-bearing column");
    }
  });
});

describe("EditorStore without a database", () => {
  const untouchable: Queryable = {
    query: (() => {
      throw new Error("must not reach the database");
    }) as unknown as Queryable["query"],
  };

  it("treats ids that are not UUIDs as missing without querying", async () => {
    const store = new EditorStore(untouchable);
    for (const id of ["", "not-a-uuid", "123", "{6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11}", "6f1d0d7c6f6c4c399a526a1f3b1c0d11", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11' OR '1'='1"]) {
      assert.equal(isPageId(id), false, id);
      assert.equal(await store.getPage("stub-user", id), null);
      assert.equal(await store.savePage("stub-user", id, { title: "x" }), null);
    }
    assert.equal(isPageId("6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"), true);
  });

  it("refuses an empty owner instead of reading rows of nobody", async () => {
    const store = new EditorStore(untouchable);
    await assert.rejects(() => store.listPages(""), TypeError);
    await assert.rejects(() => store.getPage("", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"), TypeError);
    await assert.rejects(() => store.createPage(""), TypeError);
  });
});
