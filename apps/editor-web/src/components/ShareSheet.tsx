"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ShellSheet } from "niho-docs-ui/shell";
import { SHARE_TEXT, type ShareSheetProps } from "@/lib/use-page-share";
import { isMacPlatform } from "@/lib/use-search-shortcut";
import { BUSY_STYLE, SHEET_HELP_STYLE, SHEET_STATUS_STYLE, useFocusOnPhase } from "./sheet-parts";

/** 「コピーしました」を出しておく長さ。 */
export const COPIED_NOTE_MS = 2000;

const LINK_ROW_STYLE = { display: "flex", alignItems: "center", gap: 8 } as const;
const LINK_INPUT_STYLE = { flex: "1 1 auto", minWidth: 0 } as const;
const ACTIONS_STYLE = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
const STACK_STYLE = { display: "grid", gap: 12 } as const;

type CopyNote = { text: string; url: string };

/**
 * 「…」の「リンクで共有」のシート（docs-ui の ShellSheet。外は inert、Esc・外の押下・「閉じる」で閉じ、フォーカスは「…」へ戻る）。
 * 状態と操作は use-page-share.ts。ここは表示と、コピー（クリップボードが使えなければ入力を選んでキーの案内）だけを持つ。
 * 状態の変化（読み込み中・作った・止めた・コピーした）は 1 つの role="status" で読み上げる。
 */
export function ShareSheet(props: ShareSheetProps) {
  const { load, share, busy, confirmingRotate, error, notice } = props;
  const linkId = useId();
  const confirmId = useId();
  const body = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const reloadButton = useRef<HTMLButtonElement | null>(null);
  const startButton = useRef<HTMLButtonElement | null>(null);
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const rotateButton = useRef<HTMLButtonElement | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  // 確かめるのをやめて戻った（フォーカスを「作り直す」へ戻す）
  const backFromConfirm = useRef(false);
  const [copyNote, setCopyNote] = useState<CopyNote | null>(null);

  const shared = load === "ready" && share?.status === "PUBLIC";
  const url = shared ? share.url : null;
  const phase = load !== "ready" ? load : !shared ? "private" : url === null ? "nourl" : confirmingRotate ? "confirm" : "public";

  useFocusOnPhase(phase, body, () => {
    if (phase === "failed" || phase === "nourl") return reloadButton.current;
    if (phase === "private") return startButton.current;
    // 確かめる段階へ入った・やめて戻ったときは、どこにフォーカスがあっても移す
    if (phase === "confirm") return { element: keepButton.current, force: true };
    if (phase === "public") {
      const back = backFromConfirm.current;
      backFromConfirm.current = false;
      return back ? { element: rotateButton.current, force: true } : copyButton.current;
    }
    return null;
  });

  useEffect(() => {
    if (copyNote?.text !== SHARE_TEXT.copied) return;
    const timer = setTimeout(() => setCopyNote((current) => (current === copyNote ? null : current)), COPIED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [copyNote]);

  const copy = async () => {
    if (!url) return;
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(url);
      setCopyNote({ text: SHARE_TEXT.copied, url });
    } catch {
      // 使えない（http・権限が無いなど）: 入力を選び、キーで写してもらう
      input.current?.focus();
      input.current?.select();
      setCopyNote({ text: SHARE_TEXT.copyByKey(isMacPlatform()), url });
    }
  };

  const cancelRotate = () => {
    backFromConfirm.current = true;
    props.onCancelRotate();
  };
  // 送っている間は押しても何もしない（フォーカスを外さないよう disabled にはしない）
  const unlessBusy = (action: () => void) => {
    if (!busy) action();
  };
  const busyProps = busy ? { "aria-disabled": true, style: BUSY_STYLE } : {};

  const status =
    load === "loading" ? SHARE_TEXT.loading : busy ? "" : copyNote && copyNote.url === url ? copyNote.text : (notice ?? "");

  return (
    // Esc・外の押下は、作り直しを確かめているときは確かめるのをやめるだけ
    <ShellSheet label={SHARE_TEXT.title} onClose={confirmingRotate ? cancelRotate : props.onClose}>
      <div className="es-sh-hd">
        <h2>{shared ? SHARE_TEXT.titleShared : SHARE_TEXT.title}</h2>
      </div>
      <div ref={body} className="es-sh-body">
        <div className="es-sh-sec" style={STACK_STYLE}>
          <p style={SHEET_HELP_STYLE}>{SHARE_TEXT.about}</p>
          {phase === "failed" && (
            <div style={ACTIONS_STYLE}>
              <button ref={reloadButton} type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onReload}>
                {SHARE_TEXT.reload}
              </button>
            </div>
          )}
          {phase === "nourl" && (
            <>
              <p style={SHEET_HELP_STYLE}>{SHARE_TEXT.noUrl}</p>
              <div style={ACTIONS_STYLE}>
                <button ref={reloadButton} type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps} onClick={() => unlessBusy(props.onReload)}>
                  {SHARE_TEXT.reload}
                </button>
                <button type="button" className="es-btn es-btn--quiet es-btn--sm" {...busyProps} onClick={() => unlessBusy(props.onStop)}>
                  {SHARE_TEXT.stop}
                </button>
              </div>
            </>
          )}
          {url !== null && (
            <>
              <div className="es-field">
                <label htmlFor={linkId}>{SHARE_TEXT.link}</label>
                <div style={LINK_ROW_STYLE}>
                  <input
                    ref={input}
                    id={linkId}
                    className="es-input"
                    style={LINK_INPUT_STYLE}
                    type="text"
                    readOnly
                    value={url}
                    spellCheck={false}
                    autoComplete="off"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button ref={copyButton} type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps} onClick={() => unlessBusy(() => void copy())}>
                    {SHARE_TEXT.copy}
                  </button>
                </div>
              </div>
              <p style={SHEET_HELP_STYLE}>{SHARE_TEXT.stopHelp}</p>
              {confirmingRotate ? (
                <div role="group" aria-labelledby={confirmId} style={STACK_STYLE}>
                  <p id={confirmId} style={{ ...SHEET_HELP_STYLE, fontWeight: 600, color: "var(--ed-ink)" }}>
                    {SHARE_TEXT.rotateHelp}
                  </p>
                  <div style={ACTIONS_STYLE}>
                    <button ref={keepButton} type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={cancelRotate}>
                      {SHARE_TEXT.cancel}
                    </button>
                    <button type="button" className="es-btn es-btn--primary es-btn--sm" {...busyProps} onClick={() => unlessBusy(props.onConfirmRotate)}>
                      {SHARE_TEXT.rotate}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={ACTIONS_STYLE}>
                  <button ref={rotateButton} type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps} onClick={() => unlessBusy(props.onRotate)}>
                    {SHARE_TEXT.rotate}
                  </button>
                  <button type="button" className="es-btn es-btn--quiet es-btn--sm" {...busyProps} onClick={() => unlessBusy(props.onStop)}>
                    {SHARE_TEXT.stop}
                  </button>
                </div>
              )}
            </>
          )}
          <p role="status" style={SHEET_STATUS_STYLE}>
            {status}
          </p>
        </div>
      </div>
      <div className="es-sh-foot">
        {error && (
          <span role="alert" className="es-sh-note es-sh-left">
            {error}
          </span>
        )}
        <span className="es-sh-acts">
          <button type="button" className="es-btn es-btn--quiet" onClick={props.onClose}>
            {SHARE_TEXT.close}
          </button>
          {phase === "private" && (
            <button ref={startButton} type="button" className="es-btn es-btn--primary" {...busyProps} onClick={() => unlessBusy(props.onStart)}>
              {SHARE_TEXT.start}
            </button>
          )}
        </span>
      </div>
    </ShellSheet>
  );
}
