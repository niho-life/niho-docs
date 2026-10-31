import type { OwnerId, Queryable } from "./types.ts";

/**
 * AI の使用量（表 ai_usage。migration 0005・0025）。owner ごと・月（Asia/Tokyo の YYYY-MM）ごと・**経路ごと**に 1 行。
 * 加算は 1 つの `INSERT … ON CONFLICT DO UPDATE` で行う（同時の要求でも足し漏れない）。
 *
 * 経路は `server`（サーバーの API。従量がかかる）と `device`（この Mac の CLI。利用者のサブスクなので従量は出ない）。
 * **月の上限（USD）で止めるのは `server` だけ**で、`device` は記録はするが止めない（設計 §6）。
 */

export const AI_USAGE_SOURCES = ["server", "device"] as const;
export type AiUsageSource = (typeof AI_USAGE_SOURCES)[number];

export function isAiUsageSource(value: unknown): value is AiUsageSource {
  return typeof value === "string" && (AI_USAGE_SOURCES as readonly string[]).includes(value);
}

/** 1 回分の加算（全て 0 以上の整数）。金額は見込みの micro-USD（1 USD = 1,000,000）。 */
export type AiUsageDelta = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
};

/** その月・その経路の合計（行が無ければ全て 0）。 */
export type AiUsageTotals = AiUsageDelta & { owner: OwnerId; month: string; source: AiUsageSource };

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Asia/Tokyo は UTC+9（夏時間なし）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

type UsageRow = { requests: number; input_tokens: string; output_tokens: string; cost_micro_usd: string };

/** その時刻の Asia/Tokyo の年月（`2026-10`）。 */
export function monthKeyJst(date: Date): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError("editor-store: invalid date");
  const jst = new Date(time + JST_OFFSET_MS);
  return `${String(jst.getUTCFullYear()).padStart(4, "0")}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を作らない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function assertMonth(month: string): void {
  if (typeof month !== "string" || !MONTH_PATTERN.test(month)) throw new TypeError("editor-store: month must be YYYY-MM");
}

function assertSource(source: AiUsageSource): void {
  if (!isAiUsageSource(source)) throw new TypeError("editor-store: usage source must be server or device");
}

function assertDelta(delta: AiUsageDelta): void {
  for (const value of [delta.requests, delta.inputTokens, delta.outputTokens, delta.costMicroUsd]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("editor-store: usage must be non-negative integers");
  }
}

function toTotals(owner: OwnerId, month: string, source: AiUsageSource, row: UsageRow | undefined): AiUsageTotals {
  return {
    owner,
    month,
    source,
    requests: row ? row.requests : 0,
    inputTokens: row ? Number(row.input_tokens) : 0,
    outputTokens: row ? Number(row.output_tokens) : 0,
    costMicroUsd: row ? Number(row.cost_micro_usd) : 0,
  };
}

const RETURNING = "requests, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens, cost_micro_usd::text AS cost_micro_usd";

/** その月・その経路の使用量に足し、足した後の合計を返す。 */
export async function recordAiUsage(db: Queryable, owner: OwnerId, month: string, delta: AiUsageDelta, source: AiUsageSource = "server"): Promise<AiUsageTotals> {
  assertOwner(owner);
  assertMonth(month);
  assertDelta(delta);
  assertSource(source);
  const result = await db.query<UsageRow>(
    `INSERT INTO ai_usage (owner, month, source, requests, input_tokens, output_tokens, cost_micro_usd)
     VALUES ($1, $2, $7, $3, $4, $5, $6)
     ON CONFLICT (owner, month, source) DO UPDATE
        SET requests = ai_usage.requests + EXCLUDED.requests,
            input_tokens = ai_usage.input_tokens + EXCLUDED.input_tokens,
            output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens,
            cost_micro_usd = ai_usage.cost_micro_usd + EXCLUDED.cost_micro_usd,
            updated_at = clock_timestamp()
     RETURNING ${RETURNING}`,
    [owner, month, delta.requests, delta.inputTokens, delta.outputTokens, delta.costMicroUsd, source],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editor-store: usage upsert returned no row");
  return toTotals(owner, month, source, row);
}

/** その月・その経路の使用量（行が無ければ全て 0）。既定はサーバーの API（月の上限が効く方）。 */
export async function getAiUsage(db: Queryable, owner: OwnerId, month: string, source: AiUsageSource = "server"): Promise<AiUsageTotals> {
  assertOwner(owner);
  assertMonth(month);
  assertSource(source);
  const result = await db.query<UsageRow>(`SELECT ${RETURNING} FROM ai_usage WHERE owner = $1 AND month = $2 AND source = $3`, [owner, month, source]);
  return toTotals(owner, month, source, result.rows[0]);
}

/** その月の経路ごとの使用量（画面に両方出す。上限が効くのは server だけ）。 */
export async function getAiUsageBySource(db: Queryable, owner: OwnerId, month: string): Promise<Record<AiUsageSource, AiUsageTotals>> {
  assertOwner(owner);
  assertMonth(month);
  const result = await db.query<UsageRow & { source: AiUsageSource }>(
    `SELECT source, ${RETURNING} FROM ai_usage WHERE owner = $1 AND month = $2`,
    [owner, month],
  );
  const rows = new Map(result.rows.map((row) => [row.source, row] as const));
  return { server: toTotals(owner, month, "server", rows.get("server")), device: toTotals(owner, month, "device", rows.get("device")) };
}
