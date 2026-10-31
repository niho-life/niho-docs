import { estimateTokenCostUsd } from "@niho/docs-core";
import { DEFAULT_EDITOR_SETTINGS, isPositiveInteger, monthKeyJst, type AiUsageDelta, type AiUsageTotals, type EditorSettings, type EditorStore, type OwnerId } from "@niho/editor-store";
import { AnthropicError } from "../ai/anthropic";
import type { AiBackend } from "../ai/config";
import { applyAdoptions, buildProposal, buildRequest, type Adoptions, type AiRun, type AiScope } from "../ai/engine";
import type { AiInsertKind, AiUsageReport } from "../ai/model";
import { parseIntent, type AiIntent } from "../ai/presets";
import type { AuthProvider } from "../auth/types";
import { conflictResponse, errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseBlocks } from "./page-input";

/**
 * AI の提案と採用・使用量の API（設計 §6・Issue #38）。
 *
 * - 提案はページに何も書かない（版も残さない）。採用のときだけ、今の本文を版（ai）に残してから保存する。
 * - モデルと鍵はサーバー側（src/ai/config.ts）。`EDITOR_AI_MODE` が無効なら提案・採用は 503 `ai_unavailable`。
 *
 * pages-api.ts・deps.ts と並行して触らないよう、依存の型と guarded をここに置いている（search-api.ts と同じ作り）。
 */

/** AI の route が使う store の操作。 */
export type AiPagesStore = Pick<EditorStore, "getPage" | "savePage" | "createVersion">;

/** 使用量の読み書き（packages/editor-store の getAiUsage・recordAiUsage に Pool を渡したもの）。 */
export type AiUsageStore = {
  get: (owner: OwnerId, month: string) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta) => Promise<AiUsageTotals>;
};

/** AI の route が使うもの。route から渡す（テストでは差し替える）。 */
export type AiApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => AiPagesStore | null;
  usage: () => AiUsageStore | null;
  /** 設定（固有名詞と提案の言語。#108）。渡さない・読めないときは既定値（語彙なし・本文の言語のまま）。 */
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  /** 使えるモデル。無効のときは null（503 `ai_unavailable`）。 */
  ai: () => AiBackend | null;
  /** 月の上限（USD）。null は上限なし。 */
  limitUsd: () => number | null;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
};

/** その月の使用量（設定に出す。上限に近いときだけ箱に一言）。 */
export type UsageSummary = {
  month: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd: number | null;
  /** 使用額が上限の 80% 以上。 */
  nearLimit: boolean;
};

type AiErrorCode = "quota_exceeded" | "ai_unavailable" | "ai_failed" | "too_large";

const AI_STATUS: Record<AiErrorCode, number> = {
  // 今月の使用額が上限以上（モデルを呼ぶ前に止める）
  quota_exceeded: 429,
  // AI を使わない設定（未設定・off・本番での fake・未知の値）
  ai_unavailable: 503,
  // モデルが失敗した・出力が検証に通らない
  ai_failed: 502,
  // 送る本文が 30,000 文字を超える（範囲を選んで頼む）
  too_large: 413,
};

/** http.ts に無い AI の code。header は他の応答と同じ（jsonResponse）。 */
function aiErrorResponse(code: AiErrorCode): Response {
  return jsonResponse(AI_STATUS[code], { error: code });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * pages-api.ts の guarded と同じ。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

type InputResult<T> = { ok: true; value: T } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type ProposalInput = { baseRevision: number; intent: AiIntent; scope: AiScope | undefined };

/** POST …/ai/proposals の本文。範囲が本文の内側かはページを読んでから確かめる。 */
function parseProposalBody(body: unknown): InputResult<ProposalInput> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["baseRevision", "intent", "scope"])) return { ok: false };
  if (!isPositiveInteger(body.baseRevision)) return { ok: false };
  const intent = parseIntent(body.intent);
  if (!intent) return { ok: false };
  let scope: AiScope | undefined;
  if (body.scope !== undefined) {
    const raw = body.scope;
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["fromIndex", "toIndex"])) return { ok: false };
    if (!isNonNegativeIndex(raw.fromIndex) || !isNonNegativeIndex(raw.toIndex) || raw.fromIndex > raw.toIndex) return { ok: false };
    scope = { fromIndex: raw.fromIndex, toIndex: raw.toIndex };
  }
  return { ok: true, value: { baseRevision: body.baseRevision, intent, scope } };
}

const INSERT_KINDS: readonly string[] = ["paragraph", "heading", "callout"] satisfies readonly AiInsertKind[];

/** POST …/ai/adoptions の本文（採用するものだけ。両方空は断る）。位置と文の中身は applyAdoptions が今の本文で確かめる。 */
function parseAdoptionBody(body: unknown): InputResult<Adoptions & { baseRevision: number }> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["baseRevision", "changes", "inserts"])) return { ok: false };
  if (!isPositiveInteger(body.baseRevision)) return { ok: false };
  const rawChanges = body.changes ?? [];
  const rawInserts = body.inserts ?? [];
  if (!Array.isArray(rawChanges) || !Array.isArray(rawInserts)) return { ok: false };
  if (rawChanges.length === 0 && rawInserts.length === 0) return { ok: false };
  const changes: Adoptions["changes"] = [];
  for (const raw of rawChanges) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["index", "text"])) return { ok: false };
    if (!isNonNegativeIndex(raw.index) || typeof raw.text !== "string") return { ok: false };
    changes.push({ index: raw.index, text: raw.text });
  }
  const inserts: Adoptions["inserts"] = [];
  for (const raw of rawInserts) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["afterIndex", "kind", "text"])) return { ok: false };
    if (typeof raw.afterIndex !== "number" || !Number.isSafeInteger(raw.afterIndex) || raw.afterIndex < -1) return { ok: false };
    if (typeof raw.kind !== "string" || !INSERT_KINDS.includes(raw.kind) || typeof raw.text !== "string") return { ok: false };
    inserts.push({ afterIndex: raw.afterIndex, kind: raw.kind as AiInsertKind, text: raw.text });
  }
  return { ok: true, value: { baseRevision: body.baseRevision, changes, inserts } };
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 1 回の呼び出しの使用量を足す。金額は単価表の見込み（micro-USD に丸める）。単価が分からない・偽物は 0。 */
function addUsage(total: AiUsageDelta, backend: AiBackend, usage: AiUsageReport): void {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  total.requests += 1;
  total.inputTokens += inputTokens;
  total.outputTokens += outputTokens;
  total.costMicroUsd += usd === null ? 0 : count(Math.round(usd * 1e6));
}

function limitMicroUsd(limitUsd: number | null): number | null {
  return limitUsd === null ? null : Math.round(limitUsd * 1e6);
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  const limit = limitMicroUsd(limitUsd);
  return limit !== null && totals.costMicroUsd >= limit;
}

function summarize(totals: AiUsageTotals, limitUsd: number | null): UsageSummary {
  const limit = limitMicroUsd(limitUsd);
  return {
    month: totals.month,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd: totals.costMicroUsd / 1e6,
    limitUsd,
    // 80% 以上（整数の micro-USD で比べる）
    nearLimit: limit !== null && totals.costMicroUsd * 5 >= limit * 4,
  };
}

function currentMonth(deps: AiApiDeps): string {
  return monthKeyJst(deps.now ? deps.now() : new Date());
}

/**
 * POST /api/pages/{id}/ai/proposals — AI の提案（ページには何も書かない）。
 * `baseRevision` が今の revision と違えば 409 と今のページ。今月の使用額が上限以上なら、モデルを呼ぶ前に 429。
 * 長いページは段落の切れ目で分けて頼み、結果を 1 つの提案にまとめる。モデルの失敗・不正な出力は 502（使った分は記録する）。
 */
export function createAiProposal(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/proposals";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const usage = deps.usage();
    if (!store || !usage) return errorResponse("unavailable");
    const backend = deps.ai();
    if (!backend) return aiErrorResponse("ai_unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseProposalBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const owner = session.userId;
    const page = await store.getPage(owner, id);
    if (!page) return notFoundResponse();
    if (page.revision !== input.value.baseRevision) return conflictResponse(page);
    const settings = (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
    const plan = buildRequest(page, input.value.intent, input.value.scope, {
      glossary: settings.glossary,
      // 「書いた言語のまま」は本文の言語（buildRequest の既定）
      lang: settings.aiLang === "same" ? undefined : settings.aiLang,
    });
    if (!plan.ok) return plan.error === "too_large" ? aiErrorResponse("too_large") : errorResponse("bad_request");

    const month = currentMonth(deps);
    const limitUsd = deps.limitUsd();
    const before = await usage.get(owner, month);
    if (overLimit(before, limitUsd)) return aiErrorResponse("quota_exceeded");

    const runs: AiRun[] = [];
    const delta: AiUsageDelta = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
    let failed = false;
    for (const aiRequest of plan.requests) {
      try {
        const result = await backend.model.run(aiRequest, request.signal);
        addUsage(delta, backend, result.usage);
        runs.push({ request: aiRequest, output: result.output });
      } catch (error) {
        console.error("editor-web: ai model failed", { route, name: error instanceof Error ? error.name : "unknown" });
        // 応答は届いたが使えなかった（JSON でない・途中で切れた）ときも課金されているので、その分も数える
        if (error instanceof AnthropicError && error.usage) addUsage(delta, backend, error.usage);
        failed = true;
        break;
      }
    }
    // 失敗しても、それまでに使った分は記録する
    const totals = delta.requests > 0 ? await usage.record(owner, month, delta) : before;
    if (failed) return aiErrorResponse("ai_failed");
    const built = buildProposal(page.blocks, runs, input.value.intent, page.revision);
    if (!built.ok) {
      // 理由は検証の決まった文だけ（モデルの出力そのものは書かない）
      console.error("editor-web: ai output rejected", { route, reason: built.reason });
      return aiErrorResponse("ai_failed");
    }
    return jsonResponse(200, { proposal: built.proposal, usage: summarize(totals, limitUsd) });
  });
}

/**
 * POST /api/pages/{id}/ai/adoptions — 採用したものだけを保存する。今の本文を版（ai）に残してから、`baseRevision` 付きで保存する
 * （履歴から戻せる）。`baseRevision` が違えば 409 と今のページ。当てた結果が保存できる形でなければ 400（何も書かない）。
 */
export function adoptAiProposal(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/ai/adoptions", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store || !deps.usage()) return errorResponse("unavailable");
    if (!deps.ai()) return aiErrorResponse("ai_unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseAdoptionBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const owner = session.userId;
    const page = await store.getPage(owner, id);
    if (!page) return notFoundResponse();
    const { baseRevision, changes, inserts } = input.value;
    if (page.revision !== baseRevision) return conflictResponse(page);
    const applied = applyAdoptions(page.blocks, { changes, inserts });
    if (!applied.ok) return errorResponse("bad_request");
    // 保存のときと同じ大きさ・深さの検査
    const blocks = parseBlocks(applied.blocks);
    if (!blocks.ok) return errorResponse("bad_request");
    // 1 トランザクションにまとめるのは後段（版を残した後に別の保存が先に入れば、版は残ったまま 409 になる）
    const version = await store.createVersion(owner, id, "ai");
    if (!version) return notFoundResponse();
    const result = await store.savePage(owner, id, { blocks: blocks.value }, { baseRevision });
    if (!result) return notFoundResponse();
    return result.status === "saved" ? jsonResponse(200, { page: result.page }) : conflictResponse(result.page);
  });
}

/** GET /api/ai/usage — 今月（Asia/Tokyo）の使用量。AI が無効でも答える（設定に出す用）。 */
export function getAiUsageSummary(request: Request, deps: AiApiDeps): Promise<Response> {
  return guarded("GET /api/ai/usage", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const usage = deps.usage();
    if (!usage) return errorResponse("unavailable");
    const totals = await usage.get(session.userId, currentMonth(deps));
    return jsonResponse(200, { usage: summarize(totals, deps.limitUsd()) });
  });
}
