import type { PagePublicationSummary, PageSummary } from "@niho/editor-store";
import type { ShellDest, ShellListItem } from "niho-docs-ui/shell";

/** 2 行目の公開先に要るもの（#39）。一覧の行（listPageChunk の PageSummary.publication）と同じ形。 */
export type SidebarPublication = PagePublicationSummary;

/** 2 行目の発信先の名前（モック v6 の DEST と同じ）。本人のサイトは「自分のサイト」。 */
const DEST_NAMES: Readonly<Record<ShellDest, string>> = { exp: "NIHO Experience", niho: "NIHO", site: "自分のサイト" };

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

/** 題名での絞り込み（読み込んだ行だけ。題名と本文の検索は #35 でこれを差し替える）。 */
export function searchPages(pages: readonly PageSummary[], query: string): PageSummary[] {
  const needle = query.normalize("NFKC").toLowerCase().trim();
  return pages.filter((page) => page.title.normalize("NFKC").toLowerCase().includes(needle));
}

/**
 * 2 行目（モック v6 の sidebar の sub と同じ順）: 公開中（限定公開を含む）は発信先の名前と印、公開をやめたページは「公開をやめた」、
 * 録音は「録音」、手順が動いているページは「作成中…」。それ以外は出さない。
 */
function subOf(page: PageSummary): ShellListItem["sub"] {
  const publication = page.publication;
  if (publication && !publication.stopped) return { text: DEST_NAMES[publication.dest], dest: publication.dest };
  if (publication?.stopped) return { text: "公開をやめた" };
  if (page.kind === "rec") return { text: "録音" };
  if (page.stepStatus === "run") return { text: "作成中…" };
  return undefined;
}

function rowOf(page: PageSummary, now: number, child: boolean): ShellListItem {
  const item: ShellListItem = { id: page.id, title: page.title, when: formatWhen(page.updatedAt, now) };
  if (child) item.child = true;
  const sub = subOf(page);
  if (sub) item.sub = sub;
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
 * 親を読み込んでいない行は上の段に出す。query があるときは題名で絞り、入れ子にせずに並べる。
 */
export function arrangeSidebarItems(pages: readonly PageSummary[], options: { now: number; query?: string }): ShellListItem[] {
  const { now } = options;
  if (options.query?.trim()) return searchPages(pages, options.query).map((page) => rowOf(page, now, false));
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
