"use client";

import "niho-ui/styles/editor-tokens.css";
import "niho-docs-ui/styles/shell.css";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { PageKind, PageLang } from "@niho/editor-store";
import { Icon, ShellProposal, type ShellProposalBlock } from "niho-docs-ui/shell";
import { MAX_INTENT_TEXT_CHARS, presetsFor, type AiIntent } from "@/ai/presets";
import { aiScopeOf, type SelectionRange } from "@/editor/ai-scope";
import type { AiBlockedReason, AiBridge } from "@/lib/ai-bridge";
import {
  AiConflictError,
  AiRequestError,
  adoptAiRequest,
  proposeAiRequest,
  type AiErrorCode,
  type Proposal,
  type ProposalChange,
  type ProposalInsert,
} from "@/lib/ai-client";
import { useEditorFrame } from "./EditorFrame";

/** 箱を開く要求（`range` が null はページ全体）。`key` が変わると箱を開き直す（別の範囲で開いた）。 */
export type AiOpenRequest = { key: number; range: SelectionRange | null };

export const AI_TEXT = {
  thinking: "考えています…",
  adopting: "反映しています…",
  nothing: "変えるところはありませんでした",
  conflict: "ページが更新されました。もう一度お試しください",
  stale: "ページを編集したので、もう一度提案を作ってください",
  done: "反映しました。履歴から戻せます",
  nearLimit: "今月の AI の使用量が上限に近づいています",
} as const;

/** 頼めない理由（1 行）。 */
export const AI_BLOCKED_TEXT: Record<AiBlockedReason | "aiUnavailable", string> = {
  aiUnavailable: "AI は設定されていません",
  new: "新しいページは、書き始めて保存されてから使えます",
  conflict: "別の画面で保存されたため保存を止めています。帯で選んでから使えます",
  offline: "オフラインのため使えません。つながってからもう一度お試しください",
  error: "保存できていないため使えません。保存できてからもう一度お試しください",
  signedOut: "ログインし直してください",
  unavailable: "この画面では AI を使えません",
};

/** 失敗の文言（本文・内部の情報は出さない）。 */
export const AI_ERROR_TEXT: Record<Exclude<AiErrorCode, "aiUnavailable">, string> = {
  signedOut: "ログインし直してください",
  quota: "今月の AI の使用量の上限に達しました",
  aiFailed: "AI が答えられませんでした。もう一度お試しください",
  tooLarge: "ページが長すぎます。範囲を選んでください",
  badRequest: "提案を作れませんでした",
  network: "つながりませんでした。もう一度お試しください",
  aborted: "中止しました",
  failed: "うまくいきませんでした。もう一度お試しください",
};

/** 採用が 400 だった（提案のあとに本文が変わり、当てられなかった）。 */
export const AI_ADOPT_REFUSED_TEXT = "反映できませんでした。もう一度提案を作ってください";

/** 反映したあとの一言を出しておく長さ。 */
export const AI_NOTICE_MS = 6000;
/** デスクトップの箱の最大幅。 */
const PANEL_MAX_WIDTH = 720;
const GUTTER = 16;

type Choice = "accept" | "keep";
type Item = { id: string; at: number; order: number; change?: ProposalChange; insert?: ProposalInsert };
type Result = { pageId: string; proposal: Proposal; items: Item[]; choices: Record<string, Choice> };
type Busy = "thinking" | "adopting" | null;

/** 変更と差し込みを本文の並び（変更の後ろにその位置の差し込み。−1 は先頭）にする。 */
function itemsOf(proposal: Proposal): Item[] {
  const changes = proposal.changes.map((change): Item => ({ id: `c${change.index}`, at: change.index, order: 0, change }));
  const inserts = proposal.inserts.map((insert, position): Item => ({ id: `i${position}`, at: insert.afterIndex, order: 1, insert }));
  // Array.prototype.sort は安定（同じ位置の差し込みは応答の順のまま）
  return [...changes, ...inserts].sort((a, b) => a.at - b.at || a.order - b.order);
}

function blocksOf(result: Result): ShellProposalBlock[] {
  return result.items.map((item) => {
    const parts = item.change ? item.change.parts : [{ ins: item.insert!.text }];
    const choice = result.choices[item.id];
    return choice ? { id: item.id, parts, done: true, note: choice === "accept" ? "採用します" : "そのままにします" } : { id: item.id, parts };
  });
}

/** 押されたキーが日本語入力の変換中のものか（確定の Enter で送らない。Safari は確定の直後に keyCode 229 を送る）。 */
function isComposingKey(event: ReactKeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

const ENTRY_STYLE: CSSProperties = { height: "auto", minHeight: 0, background: "transparent", display: "flex", justifyContent: "flex-end", margin: "4px 0" };

/** ページの上部の「AI」（選択なしでも開ける。ページ全体が対象。ページ全体で開いているときは閉じる）。 */
export function AiEntry({ expanded, onOpen }: { expanded: boolean; onOpen: () => void }) {
  return (
    <div className="es-root" data-ai-entry="" style={ENTRY_STYLE}>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label="AI に頼む（ページ全体）" aria-haspopup="dialog" aria-expanded={expanded} onClick={onOpen}>
        <Icon name="spark" />
        AI
      </button>
    </div>
  );
}

function layerStyle(narrow: boolean): CSSProperties {
  return {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    height: "auto",
    minHeight: 0,
    background: "transparent",
    // 箱の外（透明な入れ物）はクリックを通す
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: narrow ? 0 : `0 ${GUTTER}px ${GUTTER}px`,
  };
}

/**
 * 箱の入れ物を、デスクトップではページの列（一覧・情報パネルを除いた .es-canvas）の幅に合わせる。狭い画面・描画の API が無い環境では画面の幅
 * （下からのシート）。位置は描画の後に style へ直に書く（PageChrome の浮かぶ部品と同じ）。
 */
function placeLayer(node: HTMLElement, column: HTMLElement | null, narrow: boolean): void {
  const rect = column?.getBoundingClientRect();
  if (narrow || !rect || rect.width <= 0) {
    node.style.left = "0px";
    node.style.right = "0px";
    node.style.width = "";
    return;
  }
  node.style.left = `${rect.left}px`;
  node.style.right = "auto";
  node.style.width = `${rect.width}px`;
}

function usePlacement(narrow: boolean): RefObject<HTMLDivElement | null> {
  const layer = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node) return;
    const column = node.parentElement?.closest<HTMLElement>(".es-canvas") ?? node.parentElement;
    const place = () => placeLayer(node, column, narrow);
    place();
    window.addEventListener("resize", place);
    // 一覧をしまう・出すなど、画面の幅が変わらずに列の幅が変わるとき
    const observer = typeof ResizeObserver !== "undefined" && column ? new ResizeObserver(place) : null;
    if (column) observer?.observe(column);
    return () => {
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [narrow]);
  return layer;
}

/**
 * AI の箱の置き場（画面の下）と、反映したあとの一言（箱を閉じたあとも読み上げる）。箱は開いているときだけ描く。
 * shell.css の規約（`[data-docs-app-root][data-docs-shared-ui]` の中の `.es-root`）に入れるため、PageEditor の root の中に置く。
 */
export function AiLayer(props: {
  editor: Editor | null;
  bridge: AiBridge;
  kind: PageKind;
  lang: PageLang;
  request: AiOpenRequest | null;
  onClose: () => void;
}) {
  const { narrow } = useEditorFrame();
  const layer = usePlacement(narrow);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), AI_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const { editor, request, onClose } = props;
  return (
    <div ref={layer} className="es-root" data-ai-layer="" style={layerStyle(narrow)}>
      <div role="status" aria-live="polite" data-ai-notice="" style={{ pointerEvents: "auto" }}>
        {notice && !request && <p className="es-card">{notice}</p>}
      </div>
      {request && editor && !editor.isDestroyed && (
        <AiBox
          key={request.key}
          editor={editor}
          bridge={props.bridge}
          kind={props.kind}
          lang={props.lang}
          range={request.range}
          narrow={narrow}
          onClose={onClose}
          onDone={(text) => {
            setNotice(text);
            onClose();
          }}
        />
      )}
    </div>
  );
}

/**
 * AI の箱（設計 §6・Issue #38）。提案はページの本文を変えない。見て選び、採用したものだけを 1 回で反映する
 * （差し込みで後ろの位置がずれるので、1 つずつは保存しない。位置はどれも提案のもとにした本文の位置で、サーバーがまとめて当てる）。
 *
 * - 中身: ページの種類ごとの候補と、自由入力「直したいこと…」（Enter で送る。日本語の変換中の Enter では送らない）。
 * - 状態: 待機 / 考え中（中止できる）/ 結果（ShellProposal。段落ごとに「採用」「そのまま」、上に「すべて採用」「閉じる」）/ エラー。
 * - 頼む前に、未保存の入力を保存し終えてから、その revision を使う（src/lib/ai-bridge.ts）。
 * - role="dialog"（ページの編集は止めない。モーダルにしない）。開いたらフォーカスを箱へ、Esc で閉じ、閉じたら開く前の場所へ戻す。
 *   状態は aria-live="polite" で読み上げる。
 */
function AiBox(props: {
  editor: Editor;
  bridge: AiBridge;
  kind: PageKind;
  lang: PageLang;
  range: SelectionRange | null;
  narrow: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { editor, bridge, onClose, onDone } = props;
  const [preparing, setPreparing] = useState(true);
  const [blocked, setBlocked] = useState<AiBlockedReason | "aiUnavailable" | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [nearLimit, setNearLimit] = useState(false);
  const [text, setText] = useState("");
  const [choiceTick, setChoiceTick] = useState(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const adoptRef = useRef<HTMLButtonElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // 選んだ範囲（本文の編集に合わせて位置を動かす）
  const rangeRef = useRef(props.range);
  // 頼んだあとに本文を編集したか
  const editedRef = useRef(false);
  const shownRef = useRef(false);
  const busyRef = useRef<Busy>(null);

  useEffect(() => {
    shownRef.current = result !== null;
    busyRef.current = busy;
  });

  // 開いたとき: フォーカスを箱へ。閉じたとき: 頼んでいる途中なら中止し、開く前の場所（本文・「AI」のボタン）へ戻す
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      controllerRef.current?.abort();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 開く前に、未保存の入力を保存し終える（頼めないなら理由を出す）
  useEffect(() => {
    let cancelled = false;
    void bridge.prepare().then((target) => {
      if (cancelled) return;
      setPreparing(false);
      if (!target.ok) setBlocked(target.reason);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 本文の編集: 選んだ範囲の位置を動かし、提案を見せている間の編集なら提案を捨てる（反映すると 409 になる）
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const range = rangeRef.current;
      if (!transaction.docChanged || !range) return;
      rangeRef.current = { from: transaction.mapping.map(range.from, -1), to: transaction.mapping.map(range.to, 1) };
    };
    // 載せ替え（採用の結果・競合のページ）は update を起こさないので、ここに来るのは利用者の編集だけ
    const onUpdate = () => {
      editedRef.current = true;
      if (shownRef.current && busyRef.current !== "adopting") {
        setResult(null);
        setMessage(AI_TEXT.stale);
      }
    };
    editor.on("transaction", onTransaction);
    editor.on("update", onUpdate);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("update", onUpdate);
    };
  }, [editor]);

  // 押したボタンが消えた・押せなくなったら、フォーカスを箱の中に戻す（本文など、箱の外にあるフォーカスは動かさない）
  const hasResult = result !== null;
  useLayoutEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || (node.contains(active) && active instanceof HTMLButtonElement && active.disabled);
    if (!lost) return;
    const next = busy === "thinking" ? stopRef.current : hasResult ? (node.querySelector<HTMLButtonElement>(".es-prop .es-blk .es-ok") ?? adoptRef.current) : null;
    if (next && !next.disabled) next.focus();
    else node.focus();
  }, [busy, hasResult, blocked, choiceTick]);

  const fail = async (error: unknown, phase: "propose" | "adopt") => {
    if (error instanceof AiConflictError) {
      // 提案は捨て、今のページを画面に載せる
      setResult(null);
      setMessage(AI_TEXT.conflict);
      await bridge.replace(error.page, { saved: false });
      return;
    }
    const code = error instanceof AiRequestError ? error.code : "failed";
    if (code === "aiUnavailable") {
      setResult(null);
      setMessage(null);
      setBlocked("aiUnavailable");
      return;
    }
    if (phase === "adopt" && code === "badRequest") {
      setResult(null);
      setMessage(AI_ADOPT_REFUSED_TEXT);
      return;
    }
    setMessage(AI_ERROR_TEXT[code]);
  };

  const ask = async (intent: AiIntent) => {
    if (busy || blocked || preparing) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy("thinking");
    setResult(null);
    setMessage(AI_TEXT.thinking);
    try {
      const target = await bridge.prepare();
      if (controller.signal.aborted) throw new AiRequestError("aborted");
      if (!target.ok) {
        setMessage(null);
        setBlocked(target.reason);
        return;
      }
      // ここから先の編集は、提案のもとにした本文（target.revision）と食い違う
      editedRef.current = false;
      const scope = aiScopeOf(editor.state.doc, rangeRef.current);
      const response = await proposeAiRequest(target.pageId, { baseRevision: target.revision, intent, ...(scope ? { scope } : {}) }, { signal: controller.signal });
      setNearLimit(response.usage.nearLimit);
      if (editedRef.current) {
        setMessage(AI_TEXT.stale);
        return;
      }
      const items = itemsOf(response.proposal);
      if (items.length === 0) {
        setMessage(AI_TEXT.nothing);
        return;
      }
      setResult({ pageId: target.pageId, proposal: response.proposal, items, choices: {} });
      setMessage(`提案が ${items.length} 件あります`);
    } catch (error) {
      await fail(error, "propose");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(null);
    }
  };

  const sendText = () => {
    const value = text.trim();
    if (value.length === 0 || Array.from(value).length > MAX_INTENT_TEXT_CHARS) return;
    void ask({ text: value });
  };

  const choose = (id: string, choice: Choice) => {
    if (!result || busy) return;
    setResult({ ...result, choices: { ...result.choices, [id]: choice } });
    setChoiceTick((tick) => tick + 1);
  };

  /** 採用に選んだもの（`all` は全部）だけを 1 回で送る。 */
  const adopt = async (all: boolean) => {
    const current = result;
    if (!current || busy) return;
    const chosen = all ? current.items : current.items.filter((item) => current.choices[item.id] === "accept");
    if (chosen.length === 0) return;
    if (all) setResult({ ...current, choices: Object.fromEntries(current.items.map((item) => [item.id, "accept" as const])) });
    setBusy("adopting");
    setMessage(AI_TEXT.adopting);
    try {
      const page = await adoptAiRequest(current.pageId, {
        baseRevision: current.proposal.baseRevision,
        changes: chosen.flatMap((item) => (item.change ? [{ index: item.change.index, text: item.change.after }] : [])),
        inserts: chosen.flatMap((item) => (item.insert ? [{ afterIndex: item.insert.afterIndex, kind: item.insert.kind, text: item.insert.text }] : [])),
      });
      await bridge.replace(page, { saved: true });
      onDone(AI_TEXT.done);
    } catch (error) {
      await fail(error, "adopt");
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    // 反映の最中は閉じない（保存の結果を画面に載せるまで待つ）
    if (busy === "adopting") return;
    onClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isComposingKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const presets = presetsFor(props.kind, props.lang);
  const disabled = preparing || blocked !== null || busy !== null;
  const accepted = result ? result.items.filter((item) => result.choices[item.id] === "accept").length : 0;
  const decided = result ? Object.keys(result.choices).length : 0;
  const status = blocked ? AI_BLOCKED_TEXT[blocked] : (message ?? "");
  const sheetStyle: CSSProperties = {
    pointerEvents: "auto",
    width: props.narrow ? "100%" : `min(100%, ${PANEL_MAX_WIDTH}px)`,
    maxHeight: props.narrow ? "85vh" : "min(70vh, 640px)",
    // 下からのシートの下端（iPhone のホームバー）。下の帯があるときは帯が持つ
    ...(props.narrow && !result ? { paddingBottom: "env(safe-area-inset-bottom)" } : {}),
  };

  return (
    <div ref={dialogRef} className="es-sheet" role="dialog" aria-label="AI に頼む" tabIndex={-1} data-ai-box="" style={sheetStyle} onKeyDown={onKeyDown}>
      <div className="es-sh-hd">
        <Icon name="spark" />
        <h2>AI に頼む</h2>
        <span className="es-tag-no" data-ai-target="">
          {props.range ? "選んだ範囲" : "ページ全体"}
        </span>
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={busy === "adopting"} onClick={close}>
          閉じる
        </button>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <p role="status" aria-live="polite" className="es-sh-note es-sh-hint" data-ai-status="">
            {status}
          </p>
          {nearLimit && (
            <p className="es-sh-note es-sh-left" data-ai-near-limit="">
              {AI_TEXT.nearLimit}
            </p>
          )}
          {busy === "thinking" && (
            <div className="es-acts">
              <button ref={stopRef} type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => controllerRef.current?.abort()}>
                中止
              </button>
            </div>
          )}
          {result ? (
            <ShellProposal
              label={result.proposal.label}
              blocks={blocksOf(result)}
              onAccept={(id) => choose(id, "accept")}
              onKeep={(id) => choose(id, "keep")}
              onAcceptAll={() => void adopt(true)}
              onClose={() => {
                // 提案を捨てて候補へ戻る（ページは変わらない）
                if (busy) return;
                setResult(null);
                setMessage(null);
              }}
            />
          ) : (
            <>
              {presets.length > 0 && (
                <div className="es-acts" role="group" aria-label="候補">
                  {presets.map((preset) => (
                    <button key={preset.id} type="button" className="es-btn es-btn--outline es-btn--sm" disabled={disabled} onClick={() => void ask({ preset: preset.id })}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="es-composer-row" style={{ marginTop: 12 }}>
                <input
                  type="text"
                  aria-label="直したいこと"
                  placeholder="直したいこと…"
                  enterKeyHint="send"
                  maxLength={MAX_INTENT_TEXT_CHARS}
                  value={text}
                  disabled={disabled}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || isComposingKey(event)) return;
                    event.preventDefault();
                    sendText();
                  }}
                />
                <button type="button" className="es-btn es-btn--primary es-btn--sm" disabled={disabled || text.trim().length === 0} onClick={sendText}>
                  送る
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {result && (
        <div className="es-sh-foot">
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={busy !== null || decided === 0} onClick={() => setResult({ ...result, choices: {} })}>
            選び直す
          </button>
          <span className="es-sh-acts">
            <button ref={adoptRef} type="button" className="es-btn es-btn--primary es-btn--sm" disabled={busy !== null || accepted === 0} onClick={() => void adopt(false)}>
              反映する（{accepted} 件）
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
