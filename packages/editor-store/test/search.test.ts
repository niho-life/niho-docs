import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrationBody, readMigrations } from "../src/migrate.ts";
import {
  QueryTooLongError,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_MAX_TERMS,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_SNIPPET_CHARS,
  buildSnippet,
  likePattern,
  normalizeSearchQuery,
  searchPages,
  searchTerms,
} from "../src/search.ts";
import type { Queryable } from "../src/types.ts";

/** SQL の行コメントを除いた本文。 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

type Call = { text: string; values: unknown[] };

/** 渡された SQL と値を覚えるだけの DB（行は返さない）。 */
function recordingDb(): { db: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    query: (async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    }) as unknown as Queryable["query"],
  };
  return { db, calls };
}

const untouchable: Queryable = {
  query: (() => {
    throw new Error("must not reach the database");
  }) as unknown as Queryable["query"],
};

describe("migration 0003_search_text", () => {
  it("adds the generated search_text column, the trigram index on live rows, and nothing that depends on 0002", async () => {
    const file = (await readMigrations()).find((migration) => migration.name === "0003_search_text.sql");
    assert.ok(file, "0003_search_text.sql exists");
    const sql = withoutComments(migrationBody(file));
    assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm\b/);
    assert.match(sql, /CREATE FUNCTION page_search_text\(title text, blocks jsonb\)[\s\S]*?\bIMMUTABLE\b/);
    assert.match(sql, /ADD COLUMN search_text text GENERATED ALWAYS AS \(page_search_text\(title, blocks\)\) STORED NOT NULL/);
    assert.match(sql, /CREATE INDEX pages_search_text_trgm_idx ON pages USING gin \(search_text %I\.gin_trgm_ops\) WHERE deleted_at IS NULL/);
    // 0002（版・ゴミ箱）が無い DB にも流せる: 0001 の列だけを使う
    assert.doesNotMatch(sql, /\brevision\b|page_versions|\btrash\b/i);
    // 本文の文字だけを拾い、JSON の key・type の名前は拾わない
    assert.match(sql, /n\.value ->> 'type' = 'text' AND jsonb_typeof\(n\.value -> 'text'\) = 'string'/);
  });
});

describe("search query parsing", () => {
  it("trims and collapses whitespace including newlines and ideographic spaces", () => {
    assert.equal(normalizeSearchQuery("  りんご\u3000 みかん\n\tbanana  "), "りんご みかん banana");
    assert.equal(normalizeSearchQuery(" \u3000\n"), "");
  });

  it("splits into AND terms, drops case-only duplicates, and keeps the first eight terms", () => {
    assert.deepEqual(searchTerms("Alpha beta ALPHA 猫"), ["Alpha", "beta", "猫"]);
    const many = Array.from({ length: 12 }, (_, index) => `w${index}`);
    assert.deepEqual(searchTerms(many.join(" ")), many.slice(0, SEARCH_MAX_TERMS));
    assert.equal(SEARCH_MAX_TERMS, 8);
    assert.deepEqual(searchTerms("   "), []);
  });

  it("refuses queries longer than 100 characters (counted in code points after collapsing whitespace)", () => {
    assert.equal(SEARCH_QUERY_MAX_CHARS, 100);
    assert.deepEqual(searchTerms("あ".repeat(100)), ["あ".repeat(100)]);
    assert.deepEqual(searchTerms("😀".repeat(100)), ["😀".repeat(100)], "surrogate pairs count once");
    assert.deepEqual(searchTerms(`  ${"a".repeat(50)}      ${"b".repeat(49)}  `).length, 2, "whitespace runs count once");
    assert.throws(() => searchTerms("あ".repeat(101)), QueryTooLongError);
    assert.throws(() => searchTerms("a".repeat(101)), RangeError, "QueryTooLongError is a RangeError");
  });

  it("escapes LIKE wildcards and the escape character so that they match literally", () => {
    assert.equal(likePattern("100%"), "%100\\%%");
    assert.equal(likePattern("snake_case"), "%snake\\_case%");
    assert.equal(likePattern("C:\\temp"), "%C:\\\\temp%");
    assert.equal(likePattern("猫"), "%猫%");
  });
});

describe("searchPages without a database", () => {
  it("returns [] for an empty query without querying", async () => {
    assert.deepEqual(await searchPages(untouchable, "owner-a", ""), []);
    assert.deepEqual(await searchPages(untouchable, "owner-a", " \u3000 "), []);
    assert.deepEqual(await searchPages(untouchable, "owner-a", "a\u0000b"), [], "NUL cannot be stored, so it matches nothing");
  });

  it("refuses an empty owner, a query that is too long, and a limit outside 1..100 before querying", async () => {
    await assert.rejects(() => searchPages(untouchable, "", "x"), TypeError);
    await assert.rejects(() => searchPages(untouchable, "", ""), TypeError);
    await assert.rejects(() => searchPages(untouchable, "owner-a", "x".repeat(101)), QueryTooLongError);
    for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
      await assert.rejects(() => searchPages(untouchable, "owner-a", "x", { limit }), RangeError, String(limit));
    }
  });

  it("sends a constant SQL text with every term as a parameter, scoped to the owner and live rows", async () => {
    const { db, calls } = recordingDb();
    const hostile = "x' OR '1'='1 %_\\ ;DROP";
    await searchPages(db, "owner-a", hostile);
    await searchPages(db, "owner-a", "猫", { limit: 5 });
    const [first, second] = calls;
    assert.ok(first && second);
    assert.equal(first.text, second.text, "the SQL text does not depend on the query");
    for (const fragment of ["x'", "DROP", "1'='1"]) assert.ok(!first.text.includes(fragment), fragment);
    assert.match(first.text, /WHERE owner = \$1\s+AND deleted_at IS NULL/);
    const slots = [...first.text.matchAll(/search_text ILIKE \$(\d+)::text ESCAPE '\\'/g)].map((match) => Number(match[1]));
    assert.deepEqual(slots, Array.from({ length: SEARCH_MAX_TERMS }, (_, index) => index + 5), "one ILIKE slot per term ($5..$12)");
    assert.deepEqual(first.values.slice(0, 4), ["owner-a", SEARCH_LIMIT_DEFAULT, SEARCH_SNIPPET_CHARS, ["x'", "OR", "'1'='1", "%_\\", ";DROP"]]);
    assert.deepEqual(first.values.slice(4), ["%x'%", "%OR%", "%'1'='1%", "%\\%\\_\\\\%", "%;DROP%", null, null, null]);
    assert.deepEqual(second.values.slice(0, 2), ["owner-a", 5]);
  });
});

describe("buildSnippet", () => {
  const body = (text: string, hit: string | null) => {
    const chars = Array.from(text);
    const index = hit === null ? -1 : text.indexOf(hit);
    const hitPos = index < 0 ? null : Array.from(text.slice(0, index)).length + 1;
    const from = Math.max((hitPos ?? 1) - SEARCH_SNIPPET_CHARS, 1);
    return {
      bodyChars: chars.length,
      hitPos,
      hitChars: hit === null ? 0 : Array.from(hit).length,
      excerptFrom: from,
      excerpt: chars.slice(from - 1, from - 1 + SEARCH_SNIPPET_CHARS * 2 + (hit === null ? 0 : Array.from(hit).length)).join(""),
    };
  };

  it("shows the whole short body without ellipses, with newlines turned into spaces", () => {
    assert.equal(buildSnippet(body("一行目\n二行目\n\n三行目", "二行目")), "一行目 二行目 三行目");
    assert.equal(buildSnippet(body("", null)), "");
  });

  it("cuts about 80 characters around the first hit and marks both cuts", () => {
    const text = `${"あ".repeat(300)}ハリネズミ${"い".repeat(300)}`;
    const snippet = buildSnippet(body(text, "ハリネズミ"));
    assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), snippet);
    assert.ok(snippet.includes("ハリネズミ"));
    assert.equal(Array.from(snippet).length, SEARCH_SNIPPET_CHARS + 2);
    const before = snippet.slice(1, snippet.indexOf("ハリネズミ"));
    assert.ok(before.length >= 30, "keeps context before the hit");
  });

  it("starts at the head of the body when the hit is only in the title", () => {
    const text = "本文".repeat(100);
    const snippet = buildSnippet(body(text, null));
    assert.equal(snippet, `${"本文".repeat(40)}…`);
  });

  it("fills the window backwards near the end of the body and keeps a long term whole", () => {
    const text = `${"a".repeat(200)}END`;
    const near = buildSnippet(body(text, "END"));
    assert.equal(near, `…${"a".repeat(77)}END`);
    const long = "x".repeat(100);
    const withLong = buildSnippet(body(`${"a".repeat(50)}${long}${"b".repeat(50)}`, long));
    assert.ok(withLong.includes(long), "a term longer than the window is not cut");
  });

  it("counts surrogate pairs as one character", () => {
    const text = `${"😀".repeat(100)}猫${"😀".repeat(100)}`;
    const snippet = buildSnippet(body(text, "猫"));
    assert.equal(Array.from(snippet).length, SEARCH_SNIPPET_CHARS + 2);
    assert.ok(!snippet.includes("\uFFFD"));
  });
});
