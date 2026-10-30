import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { getAiUsage, monthKeyJst, recordAiUsage, type AiUsageDelta } from "../src/ai-usage.ts";
import { applyMigrations, readMigrations } from "../src/migrate.ts";
import type { Queryable } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";

const one: AiUsageDelta = { requests: 1, inputTokens: 120, outputTokens: 30, costMicroUsd: 1_500 };

describe("monthKeyJst", () => {
  it("answers the Asia/Tokyo year and month (UTC+9)", () => {
    assert.equal(monthKeyJst(new Date("2026-10-31T14:59:59.999Z")), "2026-10");
    assert.equal(monthKeyJst(new Date("2026-10-31T15:00:00.000Z")), "2026-11");
    assert.equal(monthKeyJst(new Date("2026-12-31T15:00:00.000Z")), "2027-01");
    assert.equal(monthKeyJst(new Date("2027-01-31T23:00:00+09:00")), "2027-01");
    assert.throws(() => monthKeyJst(new Date(Number.NaN)), RangeError);
  });
});

describe("AI usage without a database", () => {
  const untouchable: Queryable = {
    query: (() => {
      throw new Error("must not reach the database");
    }) as unknown as Queryable["query"],
  };

  it("refuses an empty owner, a malformed month, and negative or fractional amounts before querying", async () => {
    await assert.rejects(() => recordAiUsage(untouchable, "", "2026-10", one), TypeError);
    await assert.rejects(() => getAiUsage(untouchable, "x".repeat(257), "2026-10"), TypeError);
    for (const month of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", ""]) {
      await assert.rejects(() => recordAiUsage(untouchable, OWNER, month, one), TypeError, month);
      await assert.rejects(() => getAiUsage(untouchable, OWNER, month), TypeError, month);
    }
    for (const delta of [
      { ...one, requests: -1 },
      { ...one, inputTokens: 1.5 },
      { ...one, outputTokens: Number.NaN },
      { ...one, costMicroUsd: 2 ** 53 },
    ]) {
      await assert.rejects(() => recordAiUsage(untouchable, OWNER, "2026-10", delta), RangeError, JSON.stringify(delta));
    }
  });
});

describe("PostgreSQL AI usage", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_ai_usage_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("applies every migration (with 0005) to an empty schema and creates an empty ai_usage", async () => {
    const client = await pool.connect();
    try {
      const names = (await readMigrations()).map((file) => file.name);
      assert.ok(names.includes("0005_ai_usage.sql"));
      assert.deepEqual((await applyMigrations(client)).applied, names);
    } finally {
      client.release();
    }
    const columns = await pool.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'ai_usage' ORDER BY ordinal_position",
      [schema],
    );
    assert.deepEqual(
      columns.rows.map((row) => [row.column_name, row.data_type]),
      [
        ["owner", "text"],
        ["month", "text"],
        ["requests", "integer"],
        ["input_tokens", "bigint"],
        ["output_tokens", "bigint"],
        ["cost_micro_usd", "bigint"],
        ["updated_at", "timestamp with time zone"],
      ],
    );
    assert.equal((await pool.query("SELECT 1 FROM ai_usage")).rows.length, 0);
  });

  it("answers zeros before any use and adds up per owner and month", async () => {
    assert.deepEqual(await getAiUsage(pool, OWNER, "2026-10"), { owner: OWNER, month: "2026-10", requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
    assert.deepEqual(await recordAiUsage(pool, OWNER, "2026-10", one), { owner: OWNER, month: "2026-10", ...one });
    const twice = await recordAiUsage(pool, OWNER, "2026-10", { requests: 2, inputTokens: 1, outputTokens: 2, costMicroUsd: 0 });
    assert.deepEqual(twice, { owner: OWNER, month: "2026-10", requests: 3, inputTokens: 121, outputTokens: 32, costMicroUsd: 1_500 });
    assert.deepEqual(await getAiUsage(pool, OWNER, "2026-10"), twice);

    // 別の月・別の owner は別の行
    await recordAiUsage(pool, OWNER, "2026-11", one);
    await recordAiUsage(pool, OTHER, "2026-10", { requests: 1, inputTokens: 5, outputTokens: 5, costMicroUsd: 7 });
    assert.deepEqual(await getAiUsage(pool, OWNER, "2026-11"), { owner: OWNER, month: "2026-11", ...one });
    assert.equal((await getAiUsage(pool, OTHER, "2026-10")).costMicroUsd, 7);
    assert.equal((await getAiUsage(pool, OWNER, "2026-10")).costMicroUsd, 1_500);
    assert.equal((await getAiUsage(pool, OTHER, "2026-11")).requests, 0);
  });

  it("adds atomically under concurrent requests", async () => {
    const owner = "synthetic-owner-concurrent";
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordAiUsage(pool, owner, "2026-12", { requests: 1, inputTokens: i, outputTokens: 2, costMicroUsd: 1_000 })));
    assert.deepEqual(await getAiUsage(pool, owner, "2026-12"), {
      owner,
      month: "2026-12",
      requests: 20,
      inputTokens: 190,
      outputTokens: 40,
      costMicroUsd: 20_000,
    });
    assert.equal((await pool.query("SELECT 1 FROM ai_usage WHERE owner = $1", [owner])).rows.length, 1);
  });

  it("keeps large token counts and amounts beyond the integer range as exact numbers", async () => {
    const big = 3_000_000_000;
    const totals = await recordAiUsage(pool, "synthetic-owner-big", "2026-10", { requests: 1, inputTokens: big, outputTokens: big, costMicroUsd: big });
    assert.equal(totals.inputTokens, big);
    assert.equal(totals.costMicroUsd, big);
  });

  it("refuses negative amounts, malformed months and empty owners in the table itself", async () => {
    const insert = (owner: string, month: string, requests: number, tokens: number, cost: number) =>
      pool.query("INSERT INTO ai_usage (owner, month, requests, input_tokens, output_tokens, cost_micro_usd) VALUES ($1, $2, $3, $4, $4, $5)", [owner, month, requests, tokens, cost]);
    for (const [owner, month, requests, tokens, cost] of [
      [OWNER, "2027-01", -1, 0, 0],
      [OWNER, "2027-02", 0, -1, 0],
      [OWNER, "2027-03", 0, 0, -1],
      [OWNER, "2027-13", 0, 0, 0],
      [OWNER, "2027-1", 0, 0, 0],
      [OWNER, "27-01", 0, 0, 0],
      ["", "2027-04", 0, 0, 0],
      ["x".repeat(257), "2027-05", 0, 0, 0],
    ] as const) {
      await assert.rejects(() => insert(owner, month, requests, tokens, cost), { code: "23514" }, `${owner.slice(0, 10)} ${month} ${requests} ${tokens} ${cost}`);
    }
    // 加算の結果が負になる更新も断る
    await assert.rejects(() => pool.query("UPDATE ai_usage SET cost_micro_usd = cost_micro_usd - 1000000000000 WHERE owner = $1", [OWNER]), { code: "23514" });
  });
});
