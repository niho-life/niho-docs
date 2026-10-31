/**
 * ブラウザから AI の提案・採用の API を呼ぶ（同じ origin。cookie・token は扱わない。モデルと鍵はサーバー側だけ）。
 * 契約はサーバー側の src/server/ai-api.ts（提案はページに何も書かない。採用のときだけ、版に残してから保存する）。
 */

import type { AiScope, Proposal, ProposalChange, ProposalInsert } from "@/ai/engine";
import type { AiIntent } from "@/ai/presets";
import { conflictPageOf, type ConflictPage } from "./pages-client";

export type { AiScope, Proposal, ProposalChange, ProposalInsert };

/** 応答のページ（採用の結果・競合のときの今のページ）。 */
export type AiPage = ConflictPage;

/**
 * 失敗の分け方（画面の文言を選ぶ。本文・内部の情報は持たない）。
 * - `signedOut` 401・`quota` 429 quota_exceeded・`aiUnavailable` 503 ai_unavailable・`aiFailed` 502 ai_failed・
 *   `tooLarge` 413・`badRequest` 400・`network` 届かなかった・`aborted` 中止した・`failed` それ以外（形の違う応答も）。
 */
export type AiErrorCode = "signedOut" | "quota" | "aiUnavailable" | "aiFailed" | "tooLarge" | "badRequest" | "network" | "aborted" | "failed";

export class AiRequestError extends Error {
  override readonly name: string = "AiRequestError";
  constructor(readonly code: AiErrorCode) {
    super(`ai request failed: ${code}`);
  }
}

/** 頼んだ revision が今のページと違った（409）。何も保存されていない。`page` は今のページ。 */
export class AiConflictError extends Error {
  override readonly name: string = "AiConflictError";
  constructor(readonly page: AiPage) {
    super("ai request conflicted");
  }
}

export type ProposalRequest = { baseRevision: number; intent: AiIntent; scope?: AiScope };
export type ProposalResult = { proposal: Proposal; usage: { nearLimit: boolean } };
export type AdoptionRequest = { baseRevision: number; changes: { index: number; text: string }[]; inserts: ProposalInsert[] };

function codeOf(status: number, error: unknown): AiErrorCode {
  if (status === 401) return "signedOut";
  if (status === 429 && error === "quota_exceeded") return "quota";
  if (status === 503 && error === "ai_unavailable") return "aiUnavailable";
  if (status === 502 && error === "ai_failed") return "aiFailed";
  if (status === 413) return "tooLarge";
  if (status === 400) return "badRequest";
  return "failed";
}

function aborted(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError");
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "network");
  }
  try {
    if (response.status === 409) {
      const page = conflictPageOf(await response.json().catch(() => null));
      // 競合の形でない 409 はただの失敗として扱う
      throw page ? new AiConflictError(page) : new AiRequestError("failed");
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new AiRequestError(codeOf(response.status, data?.error));
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AiRequestError || error instanceof AiConflictError) throw error;
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "failed");
  }
}

function pagePath(id: string, suffix: string): string {
  return `/api/pages/${encodeURIComponent(id)}${suffix}`;
}

const isIndex = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isPart(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!isRecord(value)) return false;
  return typeof value.del === "string" || typeof value.ins === "string";
}

function changeOf(value: unknown): ProposalChange | null {
  if (!isRecord(value) || !isIndex(value.index, 0) || typeof value.before !== "string" || typeof value.after !== "string") return null;
  if (!Array.isArray(value.parts) || !value.parts.every(isPart)) return null;
  return { index: value.index, before: value.before, after: value.after, parts: value.parts as ProposalChange["parts"] };
}

function insertOf(value: unknown): ProposalInsert | null {
  if (!isRecord(value) || !isIndex(value.afterIndex, -1) || typeof value.text !== "string") return null;
  if (value.kind !== "paragraph" && value.kind !== "heading" && value.kind !== "callout") return null;
  return { afterIndex: value.afterIndex, kind: value.kind, text: value.text };
}

/** 提案の応答を知っている欄だけで組み直す（形が違えば null）。 */
function proposalOf(data: unknown): ProposalResult | null {
  if (!isRecord(data) || !isRecord(data.proposal)) return null;
  const raw = data.proposal;
  if (typeof raw.label !== "string" || !isIndex(raw.baseRevision, 1) || !Array.isArray(raw.changes) || !Array.isArray(raw.inserts)) return null;
  const changes = raw.changes.map(changeOf);
  const inserts = raw.inserts.map(insertOf);
  if (changes.some((change) => change === null) || inserts.some((insert) => insert === null)) return null;
  const unchanged = isIndex(raw.unchanged, 0) ? raw.unchanged : 0;
  const nearLimit = isRecord(data.usage) && data.usage.nearLimit === true;
  return {
    proposal: { label: raw.label, baseRevision: raw.baseRevision, changes: changes as ProposalChange[], inserts: inserts as ProposalInsert[], unchanged },
    usage: { nearLimit },
  };
}

/**
 * AI の提案を頼む（ページには何も書かれない）。`baseRevision` が今のページと違えば AiConflictError。
 * `signal` で中止できる（AiRequestError `aborted`）。
 */
export async function proposeAiRequest(pageId: string, body: ProposalRequest, options: { signal?: AbortSignal } = {}): Promise<ProposalResult> {
  const result = proposalOf(await post(pagePath(pageId, "/ai/proposals"), body, options.signal));
  if (!result) throw new AiRequestError("failed");
  return result;
}

/** 採用したものだけを 1 回で保存する（今の本文は版 `ai` に残る）。保存したページを返す。`baseRevision` が違えば AiConflictError。 */
export async function adoptAiRequest(pageId: string, body: AdoptionRequest): Promise<AiPage> {
  const page = conflictPageOf(await post(pagePath(pageId, "/ai/adoptions"), body));
  if (!page) throw new AiRequestError("failed");
  return page;
}
