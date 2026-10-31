"use client";

import { useEffect, useRef, useState } from "react";
import { shellMoreItems, type ShellHeaderProps, type ShellMenuItem } from "niho-docs-ui/shell";
import { ownerOf, samePage, type AttachedPage, type PageOwner } from "./attached-page";
import { googleDocsConnectPath } from "./google-docs-paths";
import {
  PageActionError,
  deletePageRequest,
  duplicatePageRequest,
  exportPageToGoogleDoc,
  newGoogleDocExportId,
  pageExportUrl,
  type DuplicatedPage,
} from "./page-actions-client";

export type { AttachedPage, PageOwner };

/** 「…」の Google ドキュメントの項目の id。 */
const GOOGLE_DOC_ITEM = "export-google-doc";

/**
 * 「…」の項目: リンクで共有・書き出し（.md）・Google ドキュメントへ・履歴・複製・削除（docs-ui の shellMoreItems の順）。
 * shellMoreItems の「書き出し」は .md と Google ドキュメントをまとめた 1 項目だが、項目は入れ子にできないので、
 * ここで 2 つに分ける（「書き出し」は .md、Google ドキュメントは次の項目）。
 * リンクで共有の補足「共有中」は、共有していると分かっているときだけ出す（分からないときは出さない）。
 */
export function pageMenuItems(shared: boolean | null): ShellMenuItem[] {
  return shellMoreItems(shared === true).flatMap((item) =>
    item.id === "export"
      ? [{ ...item, hint: ".md" }, { id: GOOGLE_DOC_ITEM, label: "Google ドキュメントへ", icon: item.icon }]
      : [item],
  );
}


/** 「…」から開くシート（どちらも、まだ届いていない変更を保存してから開く）。 */
export type PageSheet = "share" | "history";

export const PAGE_MENU_TEXT = {
  unsaved: (action: "書き出し" | "複製" | "削除" | "共有" | "履歴") =>
    action === "履歴" ? "履歴を開く前に変更を保存できませんでした" : `${action}の前に変更を保存できませんでした`,
  duplicateFailed: "複製できませんでした",
  googleDocFailed: "Google ドキュメントへ書き出せませんでした",
  /** 方式が閉じている・NIHO 側の許可待ち（503）。 */
  googleDocUnavailable: "Google ドキュメントへの書き出しは、まだ使えません",
  /** 受け付けたが、まだできていない（202）。 */
  googleDocPending: "書き出しを受け付けました。できあがるとGoogleドライブに入ります",
  /** 送ったが結果が分からない（502 export_result_unknown）。二重に作らないよう、確かめてからやり直す。 */
  googleDocUnknown: "書き出せたか分かりません。Googleドライブを確かめてから、もう一度お試しください",
  /** 接続先が変わった・同じ受付で内容が変わった（409）。 */
  googleDocRestart: "書き出しを始めからやり直してください",
  deleteFailed: "削除できませんでした",
  published: "公開中のページは、先に公開をやめてください",
  signedOut: "ログインし直してください",
} as const;

type Owner = PageOwner;

type MenuState = {
  /** この状態を持つページ。別のページに替わったら、この状態は使わない（古い操作の結果を新しいページに出さない）。 */
  owner: Owner;
  open: boolean;
  /** 「…」の近くに出す、直前の操作の失敗。 */
  note: string | null;
  /** 削除の確認（busy は削除を送っている間）。 */
  confirm: { busy: boolean; error: string | null } | null;
};

export type PageMenuOptions = {
  page: AttachedPage | null;
  /** 今開いているページ（非同期の操作のあと、まだ同じページかを確かめる。描画を待たずに今の値を返す）。 */
  current: () => AttachedPage | null;
  /** 複製した（`stillOpen` は複製したページをまだ開いているか。違えば移動しない）。 */
  onDuplicated: (copy: DuplicatedPage, stillOpen: boolean) => void;
  /** ゴミ箱へ入れた（`stillOpen` は同上）。 */
  onDeleted: (id: string, stillOpen: boolean) => void;
  /** 保存できたので、そのページのシートを開く（まだ同じページを開いているときだけ呼ぶ）。 */
  openSheet: (sheet: PageSheet, owner: PageOwner) => void;
  /** 「…」のボタンへフォーカスを戻す（項目を選んだあと。削除の確認・シートを閉じたときの戻り先にもなる）。 */
  focusMore: () => void;
  /** 書き出しのリンクを押す（既定は同じ origin の `<a href download>`）。 */
  download?: (url: string) => void;
  /** できた Google ドキュメントを開く（既定は新しいタブ）。 */
  openDocument?: (url: string) => void;
  /** Google ドキュメントの接続の案内へ移動する（既定は今の窓で移動）。 */
  goToGoogleDocsConnect?: (path: string) => void;
};

export type PageMenu = {
  /** ShellHeader の `more`。「…」を出さないときは undefined。 */
  more: ShellHeaderProps["more"];
  note: string | null;
  confirm: { busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void } | null;
  /**
   * 情報パネルの「書き出し（Markdown）」と「ページを削除」。「…」の書き出し・削除と同じ動き（保存してから書き出す・確認してから削除）。
   * フォーカスは押したボタンに残す（削除の確認を閉じたら、押したボタンへ戻る）。「…」を出さないページでは何もしない。
   */
  exportMarkdown: () => void;
  askDelete: () => void;
};

/** できた文書を新しいタブで開く（元の窓から切り離す）。 */
export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 同じ origin の `<a href download>` を押す（本文は fetch で読まない。ファイル名は応答の Content-Disposition）。 */
export function clickDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/** 今の窓で移動する（接続の案内へ）。 */
function visit(path: string): void {
  window.location.assign(path);
}

/** Google ドキュメントの書き出しの失敗の文言（code ごと。接続が要るときは呼ぶ側が案内へ移動する）。 */
export function googleDocFailureText(error: unknown): string {
  if (error instanceof PageActionError) {
    if (error.status === 401) return PAGE_MENU_TEXT.signedOut;
    if (error.status === 503) return PAGE_MENU_TEXT.googleDocUnavailable;
    if (error.code === "export_result_unknown") return PAGE_MENU_TEXT.googleDocUnknown;
    if (error.status === 409) return PAGE_MENU_TEXT.googleDocRestart;
  }
  return PAGE_MENU_TEXT.googleDocFailed;
}

/** 操作の失敗の短い文言（ログイン切れ・公開中は理由を言い、それ以外は fallback）。 */
export function failureText(error: unknown, fallback: string): string {
  if (error instanceof PageActionError) {
    if (error.status === 409 && error.code === "published") return PAGE_MENU_TEXT.published;
    if (error.status === 401) return PAGE_MENU_TEXT.signedOut;
  }
  return fallback;
}

/**
 * ヘッダーの「…」（リンクで共有・書き出し・履歴・複製・削除）。どの操作も、まだ届いていない変更を先に保存し（`flush`）、保存できなければ止めて理由を出す。
 * リンクで共有と履歴は、保存できたらシートを開く（シートの中身は use-page-share.ts・use-page-history.ts）。
 * 操作は「…」を開いたときのページの id に対して行い、終わったときに別のページへ移っていたら、その画面には何も出さない・移動しない。
 * 同じページの操作は 1 つずつ（二重に送らない）。削除は確認のあとだけ。
 */
export function usePageMenu(options: PageMenuOptions): PageMenu {
  const [state, setState] = useState<MenuState | null>(null);
  const running = useRef<Owner | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const owner = ownerOf(options.page);
  const view = state && samePage(state.owner, owner) ? state : null;

  const isCurrent = (target: Owner) => samePage(ownerOf(latest.current.current()), target);
  const isRunning = (target: Owner) => samePage(running.current, target);
  const update = (target: Owner, change: (current: MenuState) => MenuState) =>
    setState((current) => change(current && samePage(current.owner, target) ? current : { owner: target, open: false, note: null, confirm: null }));
  // 非同期の操作の結果は、まだ同じページを開いているときだけ出す
  const report = (target: Owner, change: (current: MenuState) => MenuState) => {
    if (isCurrent(target)) update(target, change);
  };

  /** 保存してから act を行う（同じページで 1 つずつ）。保存できなければ止めて理由を出す。 */
  const run = async (target: Owner, action: "書き出し" | "複製" | "共有" | "履歴", act: () => Promise<void>) => {
    if (isRunning(target)) return;
    running.current = target;
    try {
      const saved = await target.flush();
      if (!isCurrent(target)) return;
      if (!saved) {
        report(target, (current) => ({ ...current, note: PAGE_MENU_TEXT.unsaved(action) }));
        return;
      }
      await act();
    } finally {
      if (running.current === target) running.current = null;
    }
  };

  /**
   * Google ドキュメントへ書き出す（保存したあと）。本文は送らない（サーバーが保存済みの本文から作る）。
   * できたら新しいタブで開く。未接続・つなぎ直しが要るとき（409）は接続の案内へ移動する。
   * 受付の id はこの 1 回だけのもの（同じ id で送り直すのは、呼び出し元が確かめてから）。
   */
  const exportToGoogleDoc = async (target: Owner) => {
    const next = typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;
    try {
      const result = await exportPageToGoogleDoc(target.id, newGoogleDocExportId());
      if (result.status === "pending") {
        report(target, (current) => ({ ...current, note: PAGE_MENU_TEXT.googleDocPending }));
        return;
      }
      (latest.current.openDocument ?? openInNewTab)(result.url);
    } catch (error) {
      const code = error instanceof PageActionError ? error.code : null;
      if (code === "drive_not_connected" || code === "drive_reconnect_required") {
        (latest.current.goToGoogleDocsConnect ?? visit)(googleDocsConnectPath(next));
        return;
      }
      report(target, (current) => ({ ...current, note: googleDocFailureText(error) }));
    }
  };

  /** 項目を行う。「…」から選んだときは「…」へフォーカスを戻す（情報パネルから押したときは、押したボタンに残す）。 */
  const perform = (item: string, refocus: boolean) => {
    if (!owner) return;
    const target = owner;
    if (refocus) latest.current.focusMore();
    if (item === "delete") {
      update(target, (current) => ({ ...current, open: false, note: null, confirm: { busy: false, error: null } }));
      return;
    }
    update(target, (current) => ({ ...current, open: false, note: null }));
    if (item === "export") {
      void run(target, "書き出し", async () => {
        (latest.current.download ?? clickDownload)(pageExportUrl(target.id));
      });
    } else if (item === GOOGLE_DOC_ITEM) {
      void run(target, "書き出し", async () => exportToGoogleDoc(target));
    } else if (item === "share" || item === "history") {
      const sheet: PageSheet = item;
      void run(target, sheet === "share" ? "共有" : "履歴", async () => latest.current.openSheet(sheet, target));
    } else if (item === "duplicate") {
      void run(target, "複製", async () => {
        let copy: DuplicatedPage;
        try {
          copy = await duplicatePageRequest(target.id);
        } catch (error) {
          report(target, (current) => ({ ...current, note: failureText(error, PAGE_MENU_TEXT.duplicateFailed) }));
          return;
        }
        // 複製はできている（一覧には載せる）。移動するのは、まだ元のページを開いているときだけ
        latest.current.onDuplicated(copy, isCurrent(target));
      });
    }
  };

  const confirmDelete = async (target: Owner) => {
    if (isRunning(target)) return;
    running.current = target;
    const fail = (error: string) => report(target, (current) => ({ ...current, confirm: current.confirm && { busy: false, error } }));
    try {
      update(target, (current) => ({ ...current, confirm: { busy: true, error: null } }));
      const saved = await target.flush();
      if (!isCurrent(target)) return;
      if (!saved) {
        fail(PAGE_MENU_TEXT.unsaved("削除"));
        return;
      }
      try {
        await deletePageRequest(target.id);
      } catch (error) {
        // 一覧もページもそのまま。確認のダイアログに理由を出す（閉じない）
        fail(failureText(error, PAGE_MENU_TEXT.deleteFailed));
        return;
      }
      const stillOpen = isCurrent(target);
      if (stillOpen) update(target, (current) => ({ ...current, confirm: null }));
      latest.current.onDeleted(target.id, stillOpen);
    } finally {
      if (running.current === target) running.current = null;
    }
  };

  return {
    more: owner
      ? {
          open: view?.open ?? false,
          items: pageMenuItems(options.page?.shared ?? null),
          onToggle: () => update(owner, (current) => ({ ...current, open: !current.open, note: current.open ? current.note : null })),
          onClose: () => update(owner, (current) => ({ ...current, open: false })),
          onSelect: (item) => perform(item, true),
        }
      : undefined,
    exportMarkdown: () => perform("export", false),
    askDelete: () => perform("delete", false),
    note: view?.note ?? null,
    confirm:
      owner && view?.confirm
        ? {
            ...view.confirm,
            onConfirm: () => void confirmDelete(owner),
            // 送っている間は閉じない（閉じても削除は止まらないので、結果が出るまで待つ）
            onCancel: () => {
              if (!isRunning(owner)) update(owner, (current) => ({ ...current, confirm: null }));
            },
          }
        : null,
  };
}
