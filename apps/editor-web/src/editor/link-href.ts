import { isSafeLinkHref, MAX_LINK_CHARS } from "@/ast/blocks";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export type LinkInputResult = { ok: true; href: string } | { ok: false; reason: string };

/**
 * 書式の帯の「リンク」に入れた値を検査する。保存の検査（src/ast/blocks.ts の isSafeLinkHref）と同じ規則で、
 * 通らなければ、画面に出す短い理由を返す（`javascript:`・`data:`・相対・空は断る）。前後の空白だけは除く。
 */
export function checkLinkInput(input: string): LinkInputResult {
  const href = input.trim();
  if (href.length === 0) return { ok: false, reason: "URL を入れてください。" };
  // isSafeLinkHref は型の絞り込み（href is string）なので、結果だけを見る（偽の側で href が never にならないように）
  const safe: boolean = isSafeLinkHref(href);
  if (safe) return { ok: true, href };
  if (href.length > MAX_LINK_CHARS) return { ok: false, reason: `URL が長すぎます（${MAX_LINK_CHARS} 文字まで）。` };
  if (/[\u0000- \u007f-\u009f]/.test(href)) return { ok: false, reason: "空白や制御文字を含む URL は使えません。" };
  if (parseUrl(href) === null) return { ok: false, reason: "https:// から始まる URL を入れてください（相対の URL は使えません）。" };
  return { ok: false, reason: "使えるのは https:・http:・mailto: のリンクだけです。" };
}
