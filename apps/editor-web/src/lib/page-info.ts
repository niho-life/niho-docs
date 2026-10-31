/**
 * 情報パネル（右のレールの「ページ設定」）の「ページ」の行: 作成・更新（日付）・録音（録音ページの長さ）・文字数。
 * 文字数はモック v6 の infoSections と同じく、日本語のページは文字数、英語のページは語数（「1,180 words」）。
 * 数えるのは本文だけ（題名は含めない）。空白・改行は文字に数えない。
 */

import type { PageKind, PageLang } from "@niho/editor-store";

export type TextCounts = {
  /** 空白・改行を除いた文字の数（コードポイント）。 */
  chars: number;
  /** 空白で区切った語の数。 */
  words: number;
};

export function countText(text: string): TextCounts {
  return { chars: Array.from(text.replace(/\s+/gu, "")).length, words: text.match(/\S+/gu)?.length ?? 0 };
}

const NUMBER = new Intl.NumberFormat("en-US");

/** ja は文字数（「412」）、en は語数（「1,180 words」・1 語は「1 word」）。 */
export function countLabel(counts: TextCounts, lang: PageLang): string {
  if (lang === "en") return `${NUMBER.format(counts.words)} ${counts.words === 1 ? "word" : "words"}`;
  return NUMBER.format(counts.chars);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 端末の日付（YYYY-MM-DD）。読めない時刻は空。 */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 録音の長さ（「14:38」・1 時間を超えたら「1:02:03」）。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export type PageInfoInput = {
  kind: PageKind;
  lang: PageLang;
  createdAt: string;
  updatedAt: string;
  /** 録音の長さ（秒）。録音ページでない・分からなければ null（「録音」の行を出さない）。 */
  recordingSec: number | null;
  /** 本文の数。まだ数えていない（ページを読み込んでいる）なら null（「文字数」の行を出さない）。 */
  counts: TextCounts | null;
};

/** 「ページ」の行（ShellPageSettings の info）。値の無い行は出さない。 */
export function pageInfoRows(input: PageInfoInput): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const created = formatDay(input.createdAt);
  const updated = formatDay(input.updatedAt);
  if (created) rows.push({ label: "作成", value: created });
  if (updated) rows.push({ label: "更新", value: updated });
  if (input.kind === "rec" && input.recordingSec !== null && input.recordingSec > 0) rows.push({ label: "録音", value: formatDuration(input.recordingSec) });
  if (input.counts) rows.push({ label: "文字数", value: countLabel(input.counts, input.lang) });
  return rows;
}
