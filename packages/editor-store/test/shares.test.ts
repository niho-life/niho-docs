import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DUPLICATE_TITLE_SUFFIX, PAGE_TITLE_MAX_CHARS, duplicatePage, duplicateTitle } from "../src/duplicate.ts";
import { readMigrations } from "../src/migrate.ts";
import {
  SHARE_TOKEN_PATTERN,
  enableShare,
  getShare,
  isShareToken,
  newShareToken,
  readSharedPage,
  rotateShare,
  stopShare,
} from "../src/shares.ts";
import type { Queryable } from "../src/types.ts";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

/** 呼ばれた SQL を数えるだけの DB（行は返さない）。 */
function countingDb() {
  const calls: string[] = [];
  const db: Queryable = {
    query: (async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    }) as unknown as Queryable["query"],
  };
  return { db, calls };
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("0004_page_shares.sql", () => {
  it("declares one owner-scoped share row per page with a format-checked token and no copy of the page", async () => {
    const file = (await readMigrations()).find((candidate) => candidate.name === "0004_page_shares.sql");
    assert.ok(file, "0004_page_shares.sql exists");
    const sql = withoutComments(file.sql);
    const body = sql.match(/CREATE TABLE page_shares \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.ok(body.length > 0, "page_shares is created");
    assert.match(body, /page_id uuid PRIMARY KEY/);
    assert.match(body, /owner text NOT NULL/);
    // test/schema.test.ts の秘密の列の検査は、この定義と完全に同じ列だけを外す
    assert.equal(body.split("token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$')").length, 2, "the token column is defined exactly once, as documented");
    assert.match(body, /rotated_at timestamptz,/);
    assert.match(body, /FOREIGN KEY \(owner, page_id\) REFERENCES pages \(owner, id\) ON DELETE CASCADE/);
    for (const column of ["title", "blocks", "lang", "kind", "deleted_at"]) {
      assert.doesNotMatch(body, new RegExp(`\\b${column}\\b`), `page_shares must not copy pages.${column}`);
    }
    // 0002（版・ゴミ箱。別の PR）に依存しない: 0001 の pages だけを参照する
    assert.doesNotMatch(sql, /\brevision\b|page_versions|publications|assets/);
  });
});

describe("share tokens", () => {
  it("are 43 URL-safe characters from 256 random bits, and differ every time", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 64; index++) {
      const token = newShareToken();
      assert.match(token, SHARE_TOKEN_PATTERN);
      assert.equal(token.length, 43);
      assert.equal(Buffer.from(token, "base64url").length, 32);
      tokens.add(token);
    }
    assert.equal(tokens.size, 64);
  });

  it("does not ask the database about a token that is not well formed", async () => {
    const { db, calls } = countingDb();
    const valid = "A".repeat(42) + "_";
    for (const token of ["", "short", valid.slice(1), `${valid}x`, `${valid.slice(0, 42)}=`, `${valid.slice(0, 42)}+`, `${valid.slice(0, 42)}/`, `${valid.slice(0, 41)}' OR '1'='1`, ` ${valid.slice(1)}`, `${valid.slice(0, 42)}\n`, `${valid.slice(0, 42)}あ`]) {
      assert.equal(isShareToken(token), false, JSON.stringify(token));
      assert.equal(await readSharedPage(db, token), null);
    }
    assert.equal(isShareToken(42 as unknown as string), false);
    assert.deepEqual(calls, [], "no query for a malformed token");
    assert.equal(isShareToken(valid), true);
    assert.equal(await readSharedPage(db, valid), null, "a well-formed unknown token is looked up and not found");
    assert.equal(calls.length, 1);
  });
});

describe("share and duplicate without a database", () => {
  it("treat ids that are not UUIDs as missing without querying", async () => {
    const { db, calls } = countingDb();
    for (const id of ["", "not-a-uuid", "6f1d0d7c6f6c4c399a526a1f3b1c0d11", `${PAGE_ID}' OR '1'='1`]) {
      assert.equal(await getShare(db, "stub-user", id), null);
      assert.equal(await enableShare(db, "stub-user", id), null);
      assert.equal(await rotateShare(db, "stub-user", id), null);
      assert.equal(await stopShare(db, "stub-user", id), null);
      assert.equal(await duplicatePage(db, "stub-user", id), null);
    }
    assert.deepEqual(calls, []);
  });

  it("refuse an empty owner instead of touching rows of nobody", async () => {
    const { db, calls } = countingDb();
    for (const run of [getShare, enableShare, rotateShare, stopShare, duplicatePage]) {
      await assert.rejects(() => run(db, "", PAGE_ID), TypeError);
    }
    assert.deepEqual(calls, []);
  });

  it("pass every value as a parameter, never inside the SQL text", async () => {
    const { db, calls } = countingDb();
    const owner = "synthetic-owner'; DROP TABLE pages; --";
    await getShare(db, owner, PAGE_ID);
    await enableShare(db, owner, PAGE_ID);
    await rotateShare(db, owner, PAGE_ID);
    await stopShare(db, owner, PAGE_ID);
    await duplicatePage(db, owner, PAGE_ID);
    await readSharedPage(db, "B".repeat(43));
    assert.ok(calls.length >= 6);
    for (const sql of calls) {
      assert.ok(!sql.includes(owner) && !sql.includes(PAGE_ID) && !sql.includes("B".repeat(43)), sql);
    }
  });
});

describe("duplicateTitle", () => {
  it("keeps an empty title empty and appends のコピー otherwise", () => {
    assert.equal(DUPLICATE_TITLE_SUFFIX, "のコピー");
    assert.equal(duplicateTitle(""), "");
    assert.equal(duplicateTitle("合成の題名"), "合成の題名のコピー");
    assert.equal(duplicateTitle(" "), " のコピー");
  });

  it("cuts the original title by code points so the result fits in 500 characters", () => {
    const fits = "あ".repeat(PAGE_TITLE_MAX_CHARS - 4);
    assert.equal(duplicateTitle(fits), `${fits}のコピー`);
    assert.equal(Array.from(duplicateTitle(fits)).length, PAGE_TITLE_MAX_CHARS);
    for (const length of [497, 499, 500]) {
      const title = "い".repeat(length);
      const copy = duplicateTitle(title);
      assert.equal(Array.from(copy).length, PAGE_TITLE_MAX_CHARS, String(length));
      assert.ok(copy.endsWith("のコピー"));
    }
    // 4 バイトの文字（UTF-16 では 2 単位）も 1 文字として数え、途中で割らない
    const emoji = "😀".repeat(PAGE_TITLE_MAX_CHARS);
    const copy = duplicateTitle(emoji);
    assert.equal(Array.from(copy).length, PAGE_TITLE_MAX_CHARS);
    assert.equal(copy, `${"😀".repeat(PAGE_TITLE_MAX_CHARS - 4)}のコピー`);
    assert.doesNotMatch(copy, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone surrogate");
  });
});
