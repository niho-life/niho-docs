"use client";

import { useEffect, useRef, useState } from "react";
import { ownerOf, samePage, type AttachedPage, type PageOwner } from "./attached-page";
import { PageActionError, listPageVersions, restorePageVersion, type PageVersionRow, type RestoredPage } from "./page-actions-client";
import { PAGE_MENU_TEXT } from "./use-page-menu";

/**
 * 履歴のシートの言葉。版は「その時点の本文」（題名は持たない）で、サーバーは戻す前の今の本文を版（restore）に残してから戻す
 * （今の本文が空か、最新の版と同じなら残さない。そのときも、その本文は既に履歴にある）。
 */
export const HISTORY_TEXT = {
  title: "履歴",
  list: "版の一覧",
  loading: "読み込み中",
  loadFailed: "履歴を読み込めませんでした",
  reload: "読み直す",
  empty: "まだ履歴がありません",
  restore: "この版に戻す",
  confirmLabel: "この版に戻す",
  confirmTitle: "この版に戻しますか？",
  confirmHelp: "本文がこの版になります（題名はそのまま）。いまの本文は、戻したあとも履歴から戻せます。",
  confirm: "戻す",
  cancel: "やめる",
  close: "閉じる",
  blocks: (count: number) => `${count} ブロック`,
  /** 版を残した理由（editor-store の VERSION_REASONS）。版の中身は、その操作の前の本文。 */
  reasons: { autosave: "自動保存", ai: "AI の提案の前", publish: "公開", overwrite: "上書きの前", restore: "戻す前" } as Record<string, string>,
  otherReason: "保存",
  unsaved: "戻す前に変更を保存できませんでした",
  conflict: "別の画面で保存されました。開き直してからもう一度",
  unrestorable: "この版には戻せません",
  restoreFailed: "戻せませんでした",
  restored: "この版の本文に戻しました",
} as const;

export function versionReasonText(reason: string): string {
  return HISTORY_TEXT.reasons[reason] ?? HISTORY_TEXT.otherReason;
}

/** 戻したことの知らせを出しておく長さ（読み上げは出したときの 1 回）。 */
export const RESTORED_NOTICE_MS = 6000;

export type HistorySheetView = {
  load: "loading" | "ready" | "failed";
  /** 新しい順（サーバーの順のまま）。 */
  versions: PageVersionRow[];
  /** 戻すか確かめている版の番号（null は一覧）。 */
  confirming: number | null;
  /** 一覧に戻ったときにフォーカスする版（直前に確かめた版）。 */
  focus: number | null;
  /** 戻している間（閉じない・2 回目を送らない）。 */
  busy: boolean;
  error: string | null;
};

type HistoryState = { owner: PageOwner; view: HistorySheetView };

export type HistorySheetProps = HistorySheetView & {
  onPick: (version: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onReload: () => void;
  onClose: () => void;
};

export type PageHistoryOptions = {
  page: AttachedPage | null;
  /** 今開いているページ（描画を待たずに今の値を返す）。 */
  current: () => AttachedPage | null;
  /** 戻して、エディタを開き直した（枠が「…」へフォーカスを戻すのに使う）。 */
  onRestored?: (id: string) => void;
};

export type PageHistory = {
  /** シートを開いて、版の一覧を読む（「…」がまだ届いていない変更を保存してから呼ぶ）。 */
  open: (owner: PageOwner) => void;
  sheet: HistorySheetProps | null;
  /** 戻したことの知らせ（そのページの id と文。枠が読み上げる）。 */
  notice: { id: string; text: string } | null;
};

const LOADING: HistorySheetView = { load: "loading", versions: [], confirming: null, focus: null, busy: false, error: null };

function restoreFailure(error: unknown): string {
  if (error instanceof PageActionError) {
    if (error.status === 409) return HISTORY_TEXT.conflict;
    if (error.status === 422) return HISTORY_TEXT.unrestorable;
    if (error.status === 401) return PAGE_MENU_TEXT.signedOut;
  }
  return HISTORY_TEXT.restoreFailed;
}

/**
 * 「…」の「履歴」のシート。開くたびに版の一覧（新しい順）を読み、各行の「この版に戻す」は確かめてから送る。
 * 戻す前にもう一度まだ届いていない変更を保存し（届かなければ止める）、今の revision を `baseRevision` に送る。
 * 戻せたら、開いているエディタをサーバーの戻したページで開き直し（revision も応答の値。次の保存は競合にならない）、シートを閉じて知らせる。
 * 戻している間はシートを閉じず、2 回目を送らない。結果は開いたページにだけ出す（別のページへ移っていたら何もしない）。
 */
export function usePageHistory(options: PageHistoryOptions): PageHistory {
  const [state, setState] = useState<HistoryState | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const restoring = useRef<PageOwner | null>(null);
  const sequence = useRef(0);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice((current) => (current === notice ? null : current)), RESTORED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const owner = ownerOf(options.page);
  const view = state && samePage(state.owner, owner) ? state.view : null;

  const isCurrent = (target: PageOwner) => samePage(ownerOf(latest.current.current()), target);
  const change = (target: PageOwner, next: (view: HistorySheetView) => HistorySheetView) =>
    setState((current) => (current && samePage(current.owner, target) ? { ...current, view: next(current.view) } : current));

  const load = async (target: PageOwner) => {
    const mine = ++sequence.current;
    let versions: PageVersionRow[];
    try {
      versions = await listPageVersions(target.id);
    } catch (error) {
      if (isCurrent(target) && sequence.current === mine) {
        const text = error instanceof PageActionError && error.status === 401 ? PAGE_MENU_TEXT.signedOut : HISTORY_TEXT.loadFailed;
        change(target, (view) => ({ ...view, load: "failed", error: text }));
      }
      return;
    }
    if (isCurrent(target) && sequence.current === mine) change(target, (view) => ({ ...view, load: "ready", versions, error: null }));
  };

  const open = (target: PageOwner) => {
    if (!isCurrent(target)) return;
    setState({ owner: target, view: LOADING });
    void load(target);
  };

  const restore = async (target: PageOwner, version: number) => {
    if (restoring.current !== null && samePage(restoring.current, target)) return;
    restoring.current = target;
    const fail = (error: string) => {
      if (isCurrent(target)) change(target, (view) => ({ ...view, busy: false, error }));
    };
    try {
      change(target, (view) => ({ ...view, busy: true, error: null }));
      // 開いたあとに変わったものは無いはず（シートの外は触れない）。念のため、送る前にもう一度届いたことを確かめる
      const saved = await target.flush();
      if (!isCurrent(target)) return;
      if (!saved) {
        fail(HISTORY_TEXT.unsaved);
        return;
      }
      const baseRevision = latest.current.current()?.revision() ?? null;
      if (baseRevision === null) {
        fail(HISTORY_TEXT.restoreFailed);
        return;
      }
      let restored: RestoredPage;
      try {
        restored = await restorePageVersion(target.id, version, baseRevision);
      } catch (error) {
        fail(restoreFailure(error));
        return;
      }
      // サーバーでは戻っている。別のページへ移っていたら、そのページには何もしない（戻したページは次に開いたときに読む）
      const page = latest.current.current();
      if (!page || !samePage(ownerOf(page), target)) return;
      setState(null);
      setNotice({ id: target.id, text: HISTORY_TEXT.restored });
      page.reopen(restored);
      latest.current.onRestored?.(target.id);
    } finally {
      if (restoring.current === target) restoring.current = null;
    }
  };

  const sheet: HistorySheetProps | null =
    owner && view
      ? {
          ...view,
          onPick: (version) => {
            if (!view.busy) change(owner, (current) => ({ ...current, confirming: version, error: null }));
          },
          onConfirm: () => {
            if (view.confirming !== null) void restore(owner, view.confirming);
          },
          onCancel: () => {
            if (!view.busy) change(owner, (current) => ({ ...current, confirming: null, focus: current.confirming, error: null }));
          },
          onReload: () => {
            if (view.busy) return;
            change(owner, () => LOADING);
            void load(owner);
          },
          // 戻している間は閉じない（閉じても戻すのは止まらないので、結果が出るまで待つ）
          onClose: () => {
            if (!view.busy && !(restoring.current !== null && samePage(restoring.current, owner))) setState(null);
          },
        }
      : null;

  return { open, sheet, notice };
}
