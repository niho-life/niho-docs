/**
 * ページの保存（自動保存の 1 回分）。revision（楽観ロック）を付けて送り、応答の revision に進める。
 *
 * 409（別の画面・端末が先に保存した）は、次の 2 つを競合として扱わない（自分の保存だった）:
 * - 今のページが、今送ろうとしている内容と同じ（保存は届いていたが応答を取りこぼし、同じ内容を送り直した）。
 *   → revision を 409 の応答のものに採り直して「保存済み」。
 * - 今のページが、応答を受け取れなかった前の保存（届いたかどうか分からないもの）の内容と同じ。
 *   → その保存が届いていた。revision を採り直し、その上に今の変更を 1 回だけ送り直す。
 * 内容の比較は限定 AST の canonical な形（src/ast/blocks.ts）で、object のキーの順によらない。
 */

import { validateBlocks } from "@/ast/blocks";
import type { SaveContext, SaveFailure } from "./autosave";
import { PageConflictError, PageRequestError, savePageRequest, type ConflictPage, type PageBody } from "./pages-client";

export type PageContent = { title: string; blocks: unknown[] };

/** JSON の値として等しいか（object のキーの順・undefined の項目によらない）。 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]));
}

/** 比べるための本文（限定 AST の canonical な形。空の段落 1 つだけのエディタの空のページは、空の本文と同じ）。 */
function canonicalBlocks(blocks: unknown[]): unknown[] {
  const checked = validateBlocks(blocks);
  const canonical: unknown[] = checked.ok ? checked.blocks : blocks;
  if (canonical.length === 1 && jsonEqual(canonical[0], { type: "paragraph" })) return [];
  return canonical;
}

/** 題名と本文が同じか。 */
export function sameContent(a: PageContent, b: PageContent): boolean {
  return a.title === b.title && jsonEqual(canonicalBlocks(a.blocks), canonicalBlocks(b.blocks));
}

/**
 * 保存の失敗の分け方（保存状態の表示と送り直しの判断）。
 * 409 の競合 → stopped（帯）。401 → signedOut（送り直さない）。届かなかった（TypeError・時間切れ）か
 * `navigator.onLine === false` → offline。それ以外（5xx・4xx・形の違う応答）→ error。
 */
export function classifySaveFailure(error: unknown): SaveFailure {
  if (error instanceof PageConflictError) return "stopped";
  if (error instanceof PageRequestError) return error.status === 401 ? "signedOut" : "error";
  if (error instanceof TypeError) return "offline";
  if (typeof DOMException !== "undefined" && error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "offline";
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return "error";
}

/** 届いたかどうか分からない失敗（応答が無い・読めない・5xx。サーバーは書いたかもしれない）。 */
function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof PageRequestError) || error.status >= 500;
}

/** 覚えておく「届いたかもしれない保存」の数（最初の 1 つ＝届いた見込みが最も高いものは必ず残す）。 */
const MAX_UNCERTAIN = 32;

export type PageSaver = {
  /** 次の保存で `baseRevision` として送る revision（今の本文がもとにしている revision）。 */
  readonly revision: number;
  save: (patch: PageBody, context: SaveContext) => Promise<void>;
  /** 「この内容で上書き」: 次の保存を、競合の応答のページの revision の上に `overwrite: true` で送る。 */
  overwriteOnto: (page: ConflictPage) => void;
  /** 今の本文がもとにしている revision を戻す（開いたときに、古い revision の下書きを載せた）。 */
  rebase: (revision: number) => void;
};

export function createPageSaver(options: {
  pageId: string;
  /** 読み込んだときの revision と、そのときの題名・本文。 */
  revision: number;
  content: PageContent;
  request?: typeof savePageRequest;
}): PageSaver {
  const request = options.request ?? savePageRequest;
  let revision = options.revision;
  // サーバーが `revision` のときに持っている題名・本文（部分更新を足した「送ったあとの内容」を作るため）
  let server: PageContent = options.content;
  let overwrite = false;
  let uncertain: PageContent[] = [];

  const apply = (patch: PageBody): PageContent => ({ title: patch.title ?? server.title, blocks: patch.blocks ?? server.blocks });
  const settle = (next: number, content: PageContent) => {
    revision = next;
    server = content;
    overwrite = false;
    uncertain = [];
  };
  const remember = (content: PageContent) => {
    const last = uncertain.at(-1);
    if (last && sameContent(last, content)) return;
    uncertain.push(content);
    if (uncertain.length > MAX_UNCERTAIN) uncertain.splice(1, 1);
  };

  return {
    get revision() {
      return revision;
    },
    async save(patch, context) {
      let intended = apply(patch);
      let adopted = false;
      for (;;) {
        try {
          const next = await request(options.pageId, patch, { baseRevision: revision, overwrite, keepalive: context.keepalive });
          settle(next, intended);
          return;
        } catch (error) {
          if (error instanceof PageConflictError) {
            const latest: PageContent = { title: error.page.title, blocks: error.page.blocks };
            if (sameContent(latest, intended)) {
              settle(error.page.revision, latest);
              return;
            }
            if (!adopted && uncertain.some((content) => sameContent(latest, content))) {
              adopted = true;
              settle(error.page.revision, latest);
              intended = apply(patch);
              continue;
            }
            throw error;
          }
          if (outcomeUnknown(error)) remember(intended);
          throw error;
        }
      }
    },
    overwriteOnto(page) {
      revision = page.revision;
      server = { title: page.title, blocks: page.blocks };
      overwrite = true;
      uncertain = [];
    },
    rebase(next) {
      revision = next;
    },
  };
}
