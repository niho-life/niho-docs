import type { RestoredPage } from "./page-actions-client";
import type { SaveStatus } from "./save-status";

/**
 * 開いているページ（ページの中の PageEditor が枠に登録する。ヘッダーの状態の丸と「…」が使う）。
 * 枠はページの外にあり、保存の状態とエディタはページの中にあるので、この形で橋渡しする。
 */
export type AttachedPage = {
  /** ページの id。まだ作っていない新しいページと、端末の下書きを読み終える前は null（「…」を出さない）。 */
  id: string | null;
  status: SaveStatus;
  /**
   * まだ届いていない変更を今送り、全てサーバーに届いたら true（届かなければ false。その操作は止める）。
   * 開いているあいだは同じ関数（同じ画面かどうかを、id とこの関数で見分ける）。
   */
  flush: () => Promise<boolean>;
  /** 今の本文がもとにしている revision（次の保存の `baseRevision`。版に戻すときにも送る）。作る前は null。 */
  revision: () => number | null;
  /**
   * サーバーで版に戻したページで、エディタを開き直す（題名・本文・revision をその値にし、保存と下書きの部品も作り直す）。
   * 開き直した画面は別の画面として登録し直す（flush が替わる）。
   */
  reopen: (page: RestoredPage) => void;
  /** リンクで共有しているか（ページを開いたときにサーバーが読んだ値か、このあと共有のシートで分かった値）。分からなければ null。 */
  shared: boolean | null;
  /** 共有の状態が分かった・変わった（共有のシートで読んだ・始めた・作り直した・止めた）。 */
  setShared: (shared: boolean) => void;
};

/** 操作の持ち主（ページの id と、その画面の flush）。別のページ・開き直した画面とは別の持ち主になる。 */
export type PageOwner = { id: string; flush: AttachedPage["flush"] };

export function ownerOf(page: AttachedPage | null): PageOwner | null {
  return page && page.id !== null ? { id: page.id, flush: page.flush } : null;
}

export function samePage(a: PageOwner | null, b: PageOwner | null): boolean {
  return a !== null && b !== null && a.id === b.id && a.flush === b.flush;
}
