"use client";

import { useEffect, useRef, useState } from "react";
import { DOCS_PAGE_SHARING_TEXT } from "@niho/docs-core";
import { ownerOf, samePage, type AttachedPage, type PageOwner } from "./attached-page";
import { getPageShare, rotatePageShare, startPageShare, stopPageShare, type DocsPageShareState } from "./page-actions-client";
import { failureText } from "./use-page-menu";

/** 共有のシートの言葉（docs-core の DOCS_PAGE_SHARING_TEXT と同じ語は、そこから取る）。 */
export const SHARE_TEXT = {
  title: DOCS_PAGE_SHARING_TEXT.menu,
  titleShared: DOCS_PAGE_SHARING_TEXT.active,
  about: "リンクを知っている人は、このページを読めます（ログイン不要・読み取り専用）。",
  stopHelp: "止めるとすぐに読めなくなります。",
  rotateHelp: "作り直すと、古いリンクは読めなくなります。",
  loading: "読み込み中",
  loadFailed: "共有の状態を読み込めませんでした",
  reload: "読み直す",
  link: "共有のリンク",
  start: "リンクを作る",
  copy: DOCS_PAGE_SHARING_TEXT.copy,
  copied: DOCS_PAGE_SHARING_TEXT.copied,
  copyByKey: (mac: boolean) => (mac ? "⌘C でコピー" : "Ctrl+C でコピー"),
  rotate: "作り直す",
  stop: "共有を止める",
  cancel: "やめる",
  close: "閉じる",
  noUrl: "リンクを表示できません。読み直してください",
  started: "リンクを作りました",
  rotated: "リンクを作り直しました",
  stopped: "共有を止めました",
  startFailed: "リンクを作れませんでした",
  rotateFailed: "作り直せませんでした",
  stopFailed: "共有を止められませんでした",
} as const;

type ShareOperation = "start" | "rotate" | "stop";

const OPERATIONS: Record<ShareOperation, { request: (id: string) => Promise<DocsPageShareState>; done: string; failed: string }> = {
  start: { request: startPageShare, done: SHARE_TEXT.started, failed: SHARE_TEXT.startFailed },
  rotate: { request: rotatePageShare, done: SHARE_TEXT.rotated, failed: SHARE_TEXT.rotateFailed },
  stop: { request: stopPageShare, done: SHARE_TEXT.stopped, failed: SHARE_TEXT.stopFailed },
};

/** 共有のシートに出すもの。 */
export type ShareSheetView = {
  /** 共有の状態を読んでいる・読めた・読めなかった。 */
  load: "loading" | "ready" | "failed";
  share: DocsPageShareState | null;
  /** 送っている操作（その間は、どの操作も送らない）。 */
  busy: ShareOperation | null;
  /** 「作り直す」を押して、確かめているところ。 */
  confirmingRotate: boolean;
  /** 読めなかった・操作できなかった理由。 */
  error: string | null;
  /** 済んだ操作の短い知らせ（読み上げる）。 */
  notice: string | null;
};

type ShareState = { owner: PageOwner; open: boolean; view: ShareSheetView };

export type ShareSheetProps = ShareSheetView & {
  onStart: () => void;
  /** 「作り直す」: すぐには作り直さず、確かめる。 */
  onRotate: () => void;
  onConfirmRotate: () => void;
  onCancelRotate: () => void;
  onStop: () => void;
  onReload: () => void;
  onClose: () => void;
};

export type PageShareOptions = {
  page: AttachedPage | null;
  /** 今開いているページ（描画を待たずに今の値を返す）。 */
  current: () => AttachedPage | null;
};

export type PageShare = {
  /** シートを開いて、共有の状態を読む（「…」がまだ届いていない変更を保存してから呼ぶ）。 */
  open: (owner: PageOwner) => void;
  sheet: ShareSheetProps | null;
};

const LOADING: ShareSheetView = { load: "loading", share: null, busy: null, confirmingRotate: false, error: null, notice: null };

/**
 * 「…」の「リンクで共有」のシート。開くたびに共有の状態を読み、共有していなければ「リンクを作る」、共有中なら
 * リンク・コピー・作り直す（確かめてから）・共有を止める を出す。結果は開いたページにだけ出し、そのページの「共有中」の印も更新する。
 * 操作は同じページで 1 つずつ（送っている間はシートを閉じても、もう 1 つは送らない）。閉じてもリンクは変わらない。
 * リンク（bearer）は、共有中のこのシートにだけ出す（例外・ログには入れない）。
 */
export function usePageShare(options: PageShareOptions): PageShare {
  const [state, setState] = useState<ShareState | null>(null);
  // 送っている操作の持ち主（シートを閉じて開き直しても、2 つ目を送らない）
  const sending = useRef<PageOwner | null>(null);
  // 読む・送るたびに進める（古い読みの結果で、あとの操作の結果を上書きしない）
  const sequence = useRef(0);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const owner = ownerOf(options.page);
  const view = state && state.open && samePage(state.owner, owner) ? state.view : null;

  const isCurrent = (target: PageOwner) => samePage(ownerOf(latest.current.current()), target);
  const change = (target: PageOwner, next: (view: ShareSheetView) => ShareSheetView) =>
    setState((current) => (current && samePage(current.owner, target) ? { ...current, view: next(current.view) } : current));
  const learned = (target: PageOwner, share: DocsPageShareState) => {
    const page = latest.current.current();
    if (page && samePage(ownerOf(page), target)) page.setShared(share.status === "PUBLIC");
  };

  const load = async (target: PageOwner) => {
    const mine = ++sequence.current;
    let share: DocsPageShareState;
    try {
      share = await getPageShare(target.id);
    } catch (error) {
      if (isCurrent(target) && sequence.current === mine) change(target, (view) => ({ ...view, load: "failed", error: failureText(error, SHARE_TEXT.loadFailed) }));
      return;
    }
    if (!isCurrent(target) || sequence.current !== mine) return;
    learned(target, share);
    change(target, (view) => ({ ...view, load: "ready", share, error: null }));
  };

  const open = (target: PageOwner) => {
    if (!isCurrent(target)) return;
    if (samePage(sending.current, target)) {
      // 前に開いたシートの操作がまだ終わっていない。その結果を待つ（読み直さない）
      setState((current) => (current && samePage(current.owner, target) ? { ...current, open: true } : current));
      return;
    }
    setState({ owner: target, open: true, view: LOADING });
    void load(target);
  };

  const act = async (target: PageOwner, operation: ShareOperation) => {
    if (sending.current !== null && samePage(sending.current, target)) return;
    sending.current = target;
    // 読んでいる途中の結果は使わない（この操作の結果のほうが新しい）
    const mine = ++sequence.current;
    change(target, (view) => ({ ...view, busy: operation, confirmingRotate: false, error: null, notice: null }));
    const { request, done, failed } = OPERATIONS[operation];
    try {
      let share: DocsPageShareState;
      try {
        share = await request(target.id);
      } catch (error) {
        if (isCurrent(target)) change(target, (view) => ({ ...view, busy: null, error: failureText(error, failed) }));
        return;
      }
      if (!isCurrent(target)) return;
      learned(target, share);
      if (sequence.current === mine) change(target, (view) => ({ ...view, load: "ready", share, busy: null, notice: done }));
      else change(target, (view) => ({ ...view, busy: null }));
    } finally {
      if (sending.current === target) sending.current = null;
    }
  };

  if (!owner || !view) return { open, sheet: null };
  const target = owner;
  return {
    open,
    sheet: {
      ...view,
      onStart: () => void act(target, "start"),
      onRotate: () => {
        if (!view.busy) change(target, (current) => ({ ...current, confirmingRotate: true, error: null, notice: null }));
      },
      onConfirmRotate: () => void act(target, "rotate"),
      onCancelRotate: () => change(target, (current) => ({ ...current, confirmingRotate: false })),
      onStop: () => void act(target, "stop"),
      onReload: () => {
        if (view.busy) return;
        change(target, () => LOADING);
        void load(target);
      },
      // 送っている間も閉じられる（操作はそのまま続き、結果は「共有中」の印に出る）
      onClose: () => setState((current) => (current && samePage(current.owner, target) ? { ...current, open: false, view: { ...current.view, confirmingRotate: false } } : current)),
    },
  };
}
