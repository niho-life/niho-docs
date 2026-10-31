import { tokenPrice, type ProviderId } from "@niho/docs-core";
import { createAnthropicClient, createAnthropicModel, type AnthropicClient, type AnthropicEnv } from "./anthropic";
import { createFakeClient, FAKE_CLIENT_MODEL } from "./fake-client";
import { createFakeModel } from "./fake-model";
import type { AiModel } from "./model";

/**
 * AI の有効・無効（`EDITOR_AI_MODE`）と月の上限（`EDITOR_AI_MONTHLY_LIMIT_USD`）。要求のたびに読む（build のときに固めない）。
 *
 * - 未設定・`off`: AI の route（提案・採用）は 503 `ai_unavailable`。使用量の取得は動く。
 * - `anthropic`: 本物のモデル（anthropic.ts。モデルは `EDITOR_AI_MODEL`、既定 `claude-sonnet-5-5`）。`ANTHROPIC_API_KEY` が空・未設定、
 *   モデル名の形が違う・単価表（docs-core の pricing）に無いときは 503（閉じたまま。金額を数えられないと月の上限が効かないため）。
 * - `fake`: 偽物のモデル（開発と CI だけ）。`NODE_ENV=production` では受け付けない（偽物の提案を本番の利用者に見せない）。
 * - それ以外: 未知（503）。
 */

export type AiEnv = AnthropicEnv & {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_AI_MODE?: string | undefined;
  readonly EDITOR_AI_MODEL?: string | undefined;
  readonly EDITOR_AI_MONTHLY_LIMIT_USD?: string | undefined;
};

/** 使うモデルと、見込み金額の単価表を引く提供元（偽物は null＝金額 0）。 */
export type AiBackend = { model: AiModel; provider: ProviderId | null };

/**
 * 文書を作る側（手順の段階。steps/ai-executor.ts）が使う 1 往復の口。`model` は使用量に記録する名前。
 * 有効・無効の決まりは AiBackend と同じ（同じ `EDITOR_AI_MODE` と単価表を見る）。
 */
export type AiComposeBackend = { client: AnthropicClient; model: string; provider: ProviderId | null };

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
/** モデル名の形（URL やヘッダーに混ぜられる文字を入れない）。 */
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const fakeBackend: AiBackend = { model: createFakeModel(), provider: null };
const fakeCompose: AiComposeBackend = { client: createFakeClient(), model: FAKE_CLIENT_MODEL, provider: null };

/** 使えるモデル。使えないときは null（呼び出し側で 503 `ai_unavailable`）。 */
export function resolveAiBackend(env: AiEnv): AiBackend | null {
  const mode = env.EDITOR_AI_MODE?.trim() ?? "";
  if (mode === "fake") return env.NODE_ENV === "production" ? null : fakeBackend;
  if (mode === "anthropic") {
    if ((env.ANTHROPIC_API_KEY?.trim() ?? "") === "") return null;
    const model = env.EDITOR_AI_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
    if (!MODEL_NAME.test(model)) return null;
    // 単価の無いモデルは使った金額を数えられず、月の上限が効かない。閉じたままにする
    if (tokenPrice("claude", model) === null) return null;
    // env はそのまま渡す（鍵・時間切れ・出力の上限は呼ぶたびに読む）
    return { model: createAnthropicModel({ model, env }), provider: "claude" };
  }
  return null;
}

/**
 * 文書を作る側の口（手順の段階）。使えないときは null（段階は `ai_unavailable` で失敗する）。
 * 見る環境変数・断る条件は resolveAiBackend と同じ（単価の無いモデルは、使った金額を数えられないので閉じたまま）。
 */
export function resolveAiCompose(env: AiEnv): AiComposeBackend | null {
  const mode = env.EDITOR_AI_MODE?.trim() ?? "";
  if (mode === "fake") return env.NODE_ENV === "production" ? null : fakeCompose;
  if (mode !== "anthropic") return null;
  if ((env.ANTHROPIC_API_KEY?.trim() ?? "") === "") return null;
  const model = env.EDITOR_AI_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  if (!MODEL_NAME.test(model)) return null;
  if (tokenPrice("claude", model) === null) return null;
  return { client: createAnthropicClient({ model, env }), model, provider: "claude" };
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
