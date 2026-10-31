/*
 * 一覧の行の時刻（Mac・Web で同じ言葉にする。#45）。
 * now は呼ぶ側が渡す（Web はサーバーの描画とブラウザの最初の描画で同じ値にするため）。
 */

/** 東京の日付で数える（日本は夏時間が無いので、UTC に 9 時間を足した日付）。 */
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function tokyoDay(ms: number): number {
  return Math.floor((ms + TOKYO_OFFSET_MS) / DAY_MS);
}

/**
 * 一覧の時刻。1 分未満「たった今」、1 時間未満「N分前」、同じ日「N時間前」、前の日「昨日」、7 日未満「N日前」、
 * 同じ年「M月D日」、それより前「YYYY年M月D日」。
 */
export function formatWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const elapsed = now - at;
  if (elapsed < MINUTE_MS) return "たった今";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}分前`;
  const days = tokyoDay(now) - tokyoDay(at);
  if (days === 0) return `${Math.floor(elapsed / HOUR_MS)}時間前`;
  if (days === 1) return "昨日";
  if (days < 7) return `${days}日前`;
  const date = new Date(at + TOKYO_OFFSET_MS);
  const monthDay = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return date.getUTCFullYear() === new Date(now + TOKYO_OFFSET_MS).getUTCFullYear() ? monthDay : `${date.getUTCFullYear()}年${monthDay}`;
}
