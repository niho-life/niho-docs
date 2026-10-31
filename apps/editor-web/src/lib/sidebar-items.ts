import type { PageSummary } from "@niho/editor-store";
import type { ShellListItem } from "niho-docs-ui/shell";
import type { SearchHit } from "./search-client";

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
 * 同じ年「M月D日」、それより前「YYYY年M月D日」。now は呼ぶ側が渡す（サーバーの描画とブラウザの最初の描画で同じ値にする）。
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

/** 検索の結果の行。サーバーが並べた順（更新順）のまま、当たった所の一文を 2 行目に添える。入れ子にしない。 */
export function searchRows(hits: readonly SearchHit[], now: number): ShellListItem[] {
  return hits.map((hit) => {
    const item: ShellListItem = { id: hit.id, title: hit.title, when: formatWhen(hit.updatedAt, now) };
    if (hit.snippet.trim() !== "") item.sub = { text: hit.snippet };
    return item;
  });
}

function rowOf(page: PageSummary, now: number, child: boolean): ShellListItem {
  const item: ShellListItem = { id: page.id, title: page.title, when: formatWhen(page.updatedAt, now) };
  if (child) item.child = true;
  // 2 行目の公開先は #39
  if (page.kind === "rec") item.sub = { text: "録音" };
  else if (page.stepStatus === "run") item.sub = { text: "作成中…" };
  return item;
}

/** 読み込んだ中でいちばん上の祖先。親を辿れなくなったところ（未読み込み・循環）で止める。循環なら null（その行は上の段に出す）。 */
function topAncestor(page: PageSummary, byId: ReadonlyMap<string, PageSummary>): PageSummary | null {
  const seen = new Set([page.id]);
  let top = page;
  while (top.parent) {
    const parent = byId.get(top.parent);
    if (!parent) break;
    if (seen.has(parent.id)) return null;
    seen.add(parent.id);
    top = parent;
  }
  return top;
}

/** 作った順（手順の順）。ISO 8601 の UTC の文字列は文字の順が時刻の順。 */
function byCreated(a: PageSummary, b: PageSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * サイドバーの行。上の段は渡した順（更新順）。親（か祖先）を読み込んである行は、いちばん上の祖先の直後に作った順で少し下げて並べる。
 * 親を読み込んでいない行は上の段に出す。検索の結果は `searchRows`（サーバーの検索）で出す。
 */
export function arrangeSidebarItems(pages: readonly PageSummary[], options: { now: number }): ShellListItem[] {
  const { now } = options;
  const byId = new Map(pages.map((page) => [page.id, page]));
  const children = new Map<string, PageSummary[]>();
  const tops: PageSummary[] = [];
  for (const page of pages) {
    const top = topAncestor(page, byId);
    if (top === null || top.id === page.id) {
      tops.push(page);
      continue;
    }
    const list = children.get(top.id) ?? [];
    list.push(page);
    children.set(top.id, list);
  }
  const items: ShellListItem[] = [];
  for (const top of tops) {
    items.push(rowOf(top, now, false));
    const under = (children.get(top.id) ?? []).sort(byCreated);
    for (const child of under) items.push(rowOf(child, now, true));
  }
  return items;
}
