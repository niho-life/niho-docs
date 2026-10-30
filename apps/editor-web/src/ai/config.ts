import type { ProviderId } from "@niho/docs-core";
import { createFakeModel } from "./fake-model";
import type { AiModel } from "./model";

/**
 * AI の有効・無効（`EDITOR_AI_MODE`）と月の上限（`EDITOR_AI_MONTHLY_LIMIT_USD`）。要求のたびに読む（build のときに固めない）。
 *
 * - 未設定・`off`: AI の route（提案・採用）は 503 `ai_unavailable`。使用量の取得は動く。
 * - `fake`: 偽物のモデル（開発と CI だけ）。`NODE_ENV=production` では受け付けない（偽物の提案を本番の利用者に見せない）。
 * - それ以外: この段では未知（503）。本物のプロバイダは後段で `EDITOR_AI_MODE=<provider>` として足す。
 */

export type AiEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_AI_MODE?: string | undefined;
  readonly EDITOR_AI_MONTHLY_LIMIT_USD?: string | undefined;
};

/** 使うモデルと、見込み金額の単価表を引く提供元（偽物は null＝金額 0）。 */
export type AiBackend = { model: AiModel; provider: ProviderId | null };

const fakeBackend: AiBackend = { model: createFakeModel(), provider: null };

/** 使えるモデル。使えないときは null（呼び出し側で 503 `ai_unavailable`）。 */
export function resolveAiBackend(env: AiEnv): AiBackend | null {
  const mode = env.EDITOR_AI_MODE?.trim() ?? "";
  if (mode === "fake") return env.NODE_ENV === "production" ? null : fakeBackend;
  return null;
}

/**
 * 月の上限（USD）。未設定・空は上限なし（null）。0 以上の数でない値は 0（AI を止める側に倒す）。
 */
export function monthlyLimitUsd(env: AiEnv): number | null {
  const raw = env.EDITOR_AI_MONTHLY_LIMIT_USD?.trim() ?? "";
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
