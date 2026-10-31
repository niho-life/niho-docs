"use client";

import { useId, useRef } from "react";
import { ShellSheet } from "niho-docs-ui/shell";
import type { PageVersionRow } from "@/lib/page-actions-client";
import { formatWhen } from "@/lib/sidebar-items";
import { HISTORY_TEXT, versionReasonText, type HistorySheetProps } from "@/lib/use-page-history";
import { BUSY_STYLE, SHEET_HELP_STYLE, SHEET_STATUS_STYLE, useFocusOnPhase } from "./sheet-parts";

const LIST_STYLE = { listStyle: "none", margin: 0, padding: 0 } as const;
const ROW_STYLE = { display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--ed-line)" } as const;
const ROW_TEXT_STYLE = { flex: "1 1 auto", minWidth: 0, display: "grid", gap: 2 } as const;
const ROW_WHEN_STYLE = { fontSize: 14, fontWeight: 600, color: "var(--ed-ink)" } as const;
const ROW_DETAIL_STYLE = { fontSize: 12.5, color: "var(--ed-ink-mute)" } as const;
const STACK_STYLE = { display: "grid", gap: 10 } as const;

function detail(row: PageVersionRow): string {
  return `${versionReasonText(row.reason)} · ${HISTORY_TEXT.blocks(row.blockCount)}`;
}

/**
 * 「…」の「履歴」のシート（docs-ui の ShellSheet）。一覧（新しい順。いつ・理由・ブロック数・「この版に戻す」）と、戻す前の確認。
 * 確認は同じシートの中身を替える（名前も替えるので、フォーカスは「やめる」へ移る。やめたら押した行の「この版に戻す」へ戻る）。
 * 状態と操作は use-page-history.ts。時刻は一覧と同じ formatWhen（now は枠の時計）。
 */
export function HistorySheet(props: HistorySheetProps & { now: number }) {
  const { load, versions, confirming, focus, busy, error, now } = props;
  const rowId = useId();
  const body = useRef<HTMLDivElement | null>(null);
  const reloadButton = useRef<HTMLButtonElement | null>(null);
  const picked = confirming === null ? null : versions.find((row) => row.version === confirming);
  const phase = picked ? "confirm" : load;

  useFocusOnPhase(phase, body, () => (phase === "failed" ? reloadButton.current : null));

  if (picked) {
    const busyProps = busy ? { "aria-disabled": true, style: BUSY_STYLE } : {};
    return (
      // Esc・外の押下は一覧へ戻るだけ（戻している間は何もしない）
      <ShellSheet label={HISTORY_TEXT.confirmLabel} onClose={props.onCancel}>
        <div className="es-sh-hd">
          <h2>{HISTORY_TEXT.confirmTitle}</h2>
        </div>
        <div ref={body} className="es-sh-body">
          <div className="es-sh-sec" style={STACK_STYLE}>
            <p style={ROW_TEXT_STYLE}>
              <span style={ROW_WHEN_STYLE}>{formatWhen(picked.createdAt, now)}</span>
              <span style={ROW_DETAIL_STYLE}>{detail(picked)}</span>
            </p>
            <p style={SHEET_HELP_STYLE}>{HISTORY_TEXT.confirmHelp}</p>
          </div>
        </div>
        <div className="es-sh-foot">
          {error && (
            <span role="alert" className="es-sh-note es-sh-left">
              {error}
            </span>
          )}
          <span className="es-sh-acts">
            <button type="button" className="es-btn es-btn--quiet" data-autofocus="" {...busyProps} onClick={props.onCancel}>
              {HISTORY_TEXT.cancel}
            </button>
            <button type="button" className="es-btn es-btn--primary" {...busyProps} onClick={props.onConfirm}>
              {HISTORY_TEXT.confirm}
            </button>
          </span>
        </div>
      </ShellSheet>
    );
  }

  const status = load === "loading" ? HISTORY_TEXT.loading : load === "ready" && versions.length === 0 ? HISTORY_TEXT.empty : "";
  return (
    <ShellSheet label={HISTORY_TEXT.title} onClose={props.onClose}>
      <div className="es-sh-hd">
        <h2>{HISTORY_TEXT.title}</h2>
      </div>
      <div ref={body} className="es-sh-body">
        <div className="es-sh-sec" style={STACK_STYLE}>
          <p role="status" style={load === "ready" && versions.length === 0 ? SHEET_HELP_STYLE : SHEET_STATUS_STYLE}>
            {status}
          </p>
          {load === "failed" && (
            <div>
              <button ref={reloadButton} type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onReload}>
                {HISTORY_TEXT.reload}
              </button>
            </div>
          )}
          {load === "ready" && versions.length > 0 && (
            <ol aria-label={HISTORY_TEXT.list} style={LIST_STYLE}>
              {versions.map((row) => {
                const id = `${rowId}-${row.version}`;
                return (
                  <li key={row.version} style={ROW_STYLE}>
                    <span id={id} style={ROW_TEXT_STYLE}>
                      <span style={ROW_WHEN_STYLE}>{formatWhen(row.createdAt, now)}</span>
                      <span style={ROW_DETAIL_STYLE}>{detail(row)}</span>
                    </span>
                    <button
                      type="button"
                      className="es-btn es-btn--outline es-btn--sm"
                      aria-describedby={id}
                      data-autofocus={focus === row.version ? "" : undefined}
                      onClick={() => props.onPick(row.version)}
                    >
                      {HISTORY_TEXT.restore}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
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
            {HISTORY_TEXT.close}
          </button>
        </span>
      </div>
    </ShellSheet>
  );
}
