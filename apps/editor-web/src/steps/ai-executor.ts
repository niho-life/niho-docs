import { MAX_CONTINUATIONS, estimateTokenCostUsd, joinContinuation } from "@niho/docs-core";
import {
  DEFAULT_EDITOR_SETTINGS,
  monthKeyJst,
  type AiUsageDelta,
  type AiUsageSource,
  type AiUsageTotals,
  type Block,
  type EditorSettings,
  type OwnerId,
  type ReferencePage,
} from "@niho/editor-store";
import { AnthropicError, maxTokensLimit, type AnthropicErrorKind } from "../ai/anthropic";
import { buildComposePrompt, composeBlocks, composeMaxTokens, parseComposeOutput, partialComposeBlocks, type ComposeInput, type ComposeSource } from "../ai/compose";
import type { AiComposeBackend } from "../ai/config";
import { blockText } from "../ai/engine";
import type { AiUsageReport } from "../ai/model";
import { referencesFrom } from "../ai/references";
import { StepError, type StepExecutor, type StepExecutorInput, type StepExecutorOutput } from "./executor";

/**
 * 本物の段階の実行器（Issue #37 の実行器・#38 の AI を包んだもの）。偽物（executor.ts の fakeExecutor）の差し替え先で、
 * 配線は src/server/steps-deps.ts の 1 か所。
 *
 * 1 段階 = モデルの 1 往復（ai/compose.ts のプロンプト → AnthropicClient → 検証 → 本文のブロック）。
 * 資料は段階 0 なら録音ページの本文、それ以降は前の段階の結果。
 *
 * - 月の上限は提案（server/ai-api.ts）と同じ意味で効く: 呼ぶ前に今月の使用額を見て、上限以上なら
 *   モデルを呼ばずに `quota_exceeded` で失敗する（再試行しない）。使った分は失敗しても記録する。
 * - ログ・エラーに鍵・プロンプト・本文を出さない（持つのは短い code と、あれば HTTP ステータスだけ）。
 */

/** 使用量の読み書き（server/ai-api.ts の AiUsageStore と同じ形）。 */
export type StepUsageStore = {
  get: (owner: OwnerId, month: string, source?: AiUsageSource) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta, source?: AiUsageSource) => Promise<AiUsageTotals>;
};

export type AiStepExecutorDeps = {
  /** 使える 1 往復の口（`EDITOR_AI_MODE` が無効なら null → `ai_unavailable`）。要求のたびに読む。 */
  compose: () => AiComposeBackend | null;
  /** 使用量（DB が無ければ null → `usage_unavailable`。金額を数えられないままモデルを呼ばない）。 */
  usage: () => StepUsageStore | null;
  /** 月の上限（USD）。null は上限なし。 */
  limitUsd: () => number | null;
  /** 設定（固有名詞・出力の言語・「あなたについて」。#108）。渡さない・読めないときは既定値。 */
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  /** 自動参考ページ（同じフォルダの直下のほかのページ）。渡さない・読めないときは参考なし。 */
  references?: () => ((owner: OwnerId, pageId: string) => Promise<ReferencePage[] | null>) | null;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 上流の失敗の種類から段階の失敗の code（`^[a-z0-9_]{1,64}$`）。 */
const ERROR_CODES: Record<AnthropicErrorKind, string> = {
  auth: "ai_auth",
  rate_limit: "ai_rate_limit",
  overloaded: "ai_overloaded",
  server: "ai_server",
  timeout: "ai_timeout",
  network: "ai_network",
  bad_request: "ai_bad_request",
  invalid_output: "invalid_output",
};

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 1 回の呼び出しの使用量（ai-api.ts の addUsage と同じ数え方。単価が分からない・偽物は金額 0）。 */
function usageDelta(backend: AiComposeBackend, usage: AiUsageReport): AiUsageDelta {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: usd === null ? 0 : count(Math.round(usd * 1e6)) };
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  return limitUsd !== null && totals.costMicroUsd >= Math.round(limitUsd * 1e6);
}

/** 資料（段階 0 は録音ページの本文、それ以降は前の段階の結果）。空の行は入れない。 */
function sourcesOf(input: StepExecutorInput): ComposeSource[] {
  const text = (blocks: readonly Block[]) =>
    blocks
      .map((block) => blockText(block).trim())
      .filter((line) => line.length > 0)
      .join("\n\n");
  if (input.stepIndex === 0) return [{ label: "録音ページの本文", text: text(input.parentBlocks) }];
  return [{ label: "前の段階の結果", text: text(input.previousBlocks ?? []) }];
}

/**
 * 本物の実行器。`StepExecutor` の形（executor.ts）はそのまま。`input.owner` は runner が claim で分かった
 * 持ち主を渡す（月の上限と使用量の記録に使う。無ければ数えられないので実行しない）。
 */
export function createAiStepExecutor(deps: AiStepExecutorDeps): StepExecutor {
  return {
    async run(input: StepExecutorInput): Promise<StepExecutorOutput> {
      input.signal?.throwIfAborted();
      const step = input.recipe.steps[input.stepIndex];
      if (!step) throw new StepError("unknown_step", false);
      const backend = deps.compose();
      if (!backend) throw new StepError("ai_unavailable", false);
      const usage = deps.usage();
      const owner = input.owner;
      // 使用量を数えられないままモデルを呼ばない（上限が効かなくなる）。DB の不調は一時的なので再試行する
      if (!usage || !owner) throw new StepError("usage_unavailable", true);

      const month = monthKeyJst(deps.now ? deps.now() : new Date());
      const limitUsd = deps.limitUsd();
      if (overLimit(await usage.get(owner, month), limitUsd)) throw new StepError("quota_exceeded", false);

      const settings = (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
      // 参考は、作っているサブページと同じフォルダの直下のページ（親＝録音ページの兄弟）。読めなければ参考なし
      const references = referencesFrom((await deps.references?.()?.(owner, input.parentPageId ?? "")) ?? []);
      const composeInput: ComposeInput = {
        recipeName: input.recipe.name,
        guide: input.recipe.guide,
        stepName: step.name,
        instruction: step.instruction,
        stepNumber: input.stepIndex + 1,
        stepCount: input.recipe.steps.length,
        sources: sourcesOf(input),
        // 「書いた言語のまま」は日本語（段階の資料は録音の文字起こしで、設計 §7.2 の手順はどれも日本語）
        lang: settings.aiLang === "en" ? "en" : "ja",
        glossary: settings.glossary,
        about: settings.about,
        references,
      };
      const prompt = buildComposePrompt(composeInput);

      const maxTokens = composeMaxTokens(composeInput, maxTokensLimit(deps.env ?? process.env));
      // 出力の上限で切れたら、同じ答えの続きを書かせて繋ぐ（旧アプリの「続き」。docs-core の規則と結合をそのまま使う）
      let text = "";
      let report: AiUsageReport | null = null;
      // 続きを書かせた分も足した合計（帯と記録に出す）
      let inputTokens = 0;
      let outputTokens = 0;
      let truncated = false;
      for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
        // 2 回目からは、ここまでの答えを assistant の書きかけとして渡す（モデルは止まった所の続きから書く）
        const messages: unknown[] =
          round === 0 ? [{ role: "user", content: prompt.user }] : [{ role: "user", content: prompt.user }, { role: "assistant", content: text }];
        if (round > 0 && overLimit(await usage.get(owner, month), limitUsd)) throw new StepError("quota_exceeded", false);
        let turn;
        try {
          turn = await backend.client.converse({ system: prompt.system, messages, maxTokens, ...(input.signal ? { signal: input.signal } : {}) });
        } catch (error) {
          // 応答が届いたのに使えなかった分も課金されているので記録する
          if (error instanceof AnthropicError && error.usage) await usage.record(owner, month, usageDelta(backend, error.usage));
          if (error instanceof AnthropicError) throw new StepError(ERROR_CODES[error.kind], error.retryable);
          // 中断（lease を失った・取消）は runner が世代で見分ける
          throw error;
        }
        await usage.record(owner, month, usageDelta(backend, turn.usage));
        report = turn.usage;
        inputTokens += count(turn.usage.inputTokens);
        outputTokens += count(turn.usage.outputTokens);
        const piece = turn.text.trimEnd();
        text = round === 0 ? piece : joinContinuation(text, piece);
        truncated = turn.stopReason === "max_tokens";
        // 続きが 1 字も出ないなら、これ以上は進まない（同じ要求を繰り返さない）
        if (!truncated || piece.length === 0) break;
      }
      if (!report) throw new StepError("internal", true);
      // 続きの回数を使い切っても終わらなかった。**書けた分は運ぶが、ページには書かない**（人が見て写す用）
      if (truncated) throw new StepError("output_too_long", false, partialComposeBlocks(text));

      const parsed = parseComposeOutput(parseJson(text));
      if (!parsed.ok) {
        // 理由は検証の決まった文だけ（モデルの出力そのものは書かない）
        console.error("editor-web: step output rejected", { reason: parsed.reason });
        throw new StepError("invalid_output", false);
      }
      const blocks = composeBlocks(parsed.blocks);
      if (!blocks.ok) {
        console.error("editor-web: step output rejected", { reason: blocks.reason });
        throw new StepError("invalid_output", false);
      }
      return { blocks: blocks.blocks, usage: { inputTokens, outputTokens, model: report.model } };
    },
  };
}

const FENCED = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i;

/** モデルの出力の JSON（```json … ``` で囲まれていたら外す）。読めなければ null（`invalid_output`）。 */
function parseJson(text: string): unknown {
  const fenced = FENCED.exec(text.trim());
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return null;
  }
}
