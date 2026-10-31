import type { PagePublicationSummary, PageSummary } from "@niho/editor-store";
import type { ShellDest, ShellListItem } from "niho-docs-ui/shell";
import { formatWhen } from "niho-docs-ui/page/when";
import type { SearchHit } from "./search-client";

/** 一覧の時刻は共通（packages/docs-ui の page/when.ts。Mac・Web で同じ言葉）。 */
export { formatWhen };

/** 2 行目の公開先に要るもの（#39）。一覧の行（listPageChunk の PageSummary.publication）と同じ形。 */
export type SidebarPublication = PagePublicationSummary;

/** 2 行目の発信先の名前（モック v6 の DEST と同じ）。本人のサイトは「自分のサイト」。 */
const DEST_NAMES: Readonly<Record<ShellDest, string>> = { exp: "NIHO Experience", niho: "NIHO", site: "自分のサイト" };

/** 検索の結果の行。サーバーが並べた順（更新順）のまま、当たった所の一文を 2 行目に添える。入れ子にしない。 */
export function searchRows(hits: readonly SearchHit[], now: number): ShellListItem[] {
  return hits.map((hit) => {
    const item: ShellListItem = { id: hit.id, title: hit.title, when: formatWhen(hit.updatedAt, now) };
    if (hit.snippet.trim() !== "") item.sub = { text: hit.snippet };
    return item;
  });
}

/** 手順の段階の状態の言葉（#37。色・印だけでなく文字でも出す）。済みは何も出さない（ふつうのページと同じ）。 */
const STEP_SAY: Readonly<Record<string, string>> = { run: "作成中…", wait: "待機", failed: "失敗", stale: "前提変更" };

/**
 * 2 行目（モック v6 の sidebar の sub と同じ順）: 公開中（限定公開を含む）は発信先の名前と印、公開をやめたページは「公開をやめた」、
 * 録音は「録音」、手順のサブページは段階の状態（作成中…・待機・失敗・前提変更）。それ以外は出さない。
 */
function subOf(page: PageSummary): ShellListItem["sub"] {
  const publication = page.publication;
  if (publication && !publication.stopped) return { text: DEST_NAMES[publication.dest], dest: publication.dest };
  if (publication?.stopped) return { text: "公開をやめた" };
  if (page.kind === "rec") return { text: "録音" };
  const say = page.stepStatus === null ? undefined : STEP_SAY[page.stepStatus];
  return say ? { text: say } : undefined;
}

function rowOf(page: PageSummary, now: number, child: boolean): ShellListItem {
  const item: ShellListItem = { id: page.id, title: page.title, when: formatWhen(page.updatedAt, now) };
  if (child) item.child = true;
  // 進行中の行は回るマーク（#37）。公開中のサブページでも、作っている間は印を出す
  if (page.stepStatus === "run") item.busy = true;
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

/**
 * 削除したページと、その子孫（読み込んである分。親を辿って届くもの）を除いた一覧。順は変えない。
 * サーバーは子孫ごとゴミ箱へ入れる（`DELETE /api/pages/{id}`）ので、一覧からも一緒に外す。
 */
export function withoutPageTree(pages: readonly PageSummary[], id: string): PageSummary[] {
  const removed = new Set([id]);
  // 親が先に外れていれば子も外す（並びは更新順で親子の順ではないので、外すものが増えなくなるまで繰り返す）
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (page.parent !== null && removed.has(page.parent) && !removed.has(page.id)) {
        removed.add(page.id);
        grew = true;
      }
    }
  }
  return pages.filter((page) => !removed.has(page.id));
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
