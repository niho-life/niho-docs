"use client";

import "niho-ui/styles/editor-tokens.css";
import "niho-docs-ui/styles/shell.css";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Transaction } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import type { PageKind, PageLang } from "@niho/editor-store";
import { Icon, ShellProposal, type ShellProposalBlock } from "niho-docs-ui/shell";
import { MAX_CHAT_INPUT_CHARS } from "@/ai/chat-limits";
import { intentLabel as intentTextOf, presetsFor, type AiIntent } from "@/ai/presets";
import { aiScopeOf, type SelectionRange } from "@/editor/ai-scope";
import type { AiBlockedReason, AiBridge } from "@/lib/ai-bridge";
import {
  AiConflictError,
  AiRequestError,
  adoptAiRequest,
  getAiChat,
  listAiChats,
  proposeAiRequest,
  sendAiChat,
  undoAiChat,
  type AiChatMessage,
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
  thread: "これまでのやりとり",
  fresh: "新しい会話にする",
  working: "直しています…",
  undoing: "戻しています…",
  undone: "元に戻しました",
  undoKept: "このページは、そのあと直されているので戻しませんでした",
  stopped: "途中で止まりました。もう一度頼めます",
  chatFailed: "AI が答えられませんでした。もう一度お試しください",
} as const;

/** AI が直した・作ったページの 1 行（字数の増減つき）。 */
export function aiChangeText(change: { title: string; change: "edited" | "created"; delta: number }): string {
  const name = change.title.trim() || "（題名なし）";
  const delta = change.delta > 0 ? `+${change.delta}` : String(change.delta);
  return change.change === "created" ? `${name} を作りました（${change.delta} 字）` : `${name} を直しました（${delta} 字）`;
}

/** 作業の 1 行（道具とページの名前）。 */
export const AI_TOOL_TEXT: Record<string, string> = {
  list_pages: "ページを見ました",
  read_page: "読みました",
  write_page: "書き換えました",
  create_page: "作りました",
};

export function aiItemText(item: { kind: "narration"; text: string } | { kind: "tool"; tool: string; page: string | null; ok: boolean }): string {
  if (item.kind === "narration") return item.text;
  const what = AI_TOOL_TEXT[item.tool] ?? item.tool;
  const name = item.page ? `${item.page} を` : "";
  return item.ok ? `${name}${what}` : `${name}${what}（できませんでした）`;
}

/** 反映したあとの一言（版の番号が分かるときは番号も出す。履歴から戻すときの手がかり）。 */
export function aiDoneText(version: number | null): string {
  return version === null ? AI_TEXT.done : `反映しました。版 ${version} として履歴から戻せます`;
}

/** 採用した提案に添える一言（会話の履歴に出す）。 */
export function aiAdoptedText(version: number): string {
  return `版 ${version} として残しました`;
}

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
type Result = { pageId: string; proposal: Proposal; items: Item[]; choices: Record<string, Choice>; messageId: string | null };
type Busy = "thinking" | "adopting" | "working" | "undoing" | null;

/** 変更と差し込みを本文の並び（変更の後ろにその位置の差し込み。−1 は先頭）にする。 */
function itemsOf(proposal: Proposal): Item[] {
  const changes = proposal.changes.map((change): Item => ({ id: `c${change.index}`, at: change.index, order: 0, change }));
  const inserts = proposal.inserts.map((insert, position): Item => ({ id: `i${position}`, at: insert.afterIndex, order: 1, insert }));
  // Array.prototype.sort は安定（同じ位置の差し込みは応答の順のまま）
  return [...changes, ...inserts].sort((a, b) => a.at - b.at || a.order - b.order);
}

/**
 * 画面の会話に足す 1 回のやりとり（頼んだこと → 結果の一言）。文はサーバーが会話に残すものと同じ
 * （開き直して読み込んでも並びと文が変わらない）。
 */
function turnOf(current: readonly AiChatMessage[], intent: AiIntent, result: string, messageId: string | null): AiChatMessage[] {
  const seq = (current.at(-1)?.seq ?? 0) + 1;
  const preset = "preset" in intent ? intent.preset : null;
  return [
    { id: `ask-${seq}`, seq, role: "user", text: intentTextOf(intent), preset, hasProposal: false, version: null, result: null, items: [], changes: [] },
    { id: messageId ?? `result-${seq + 1}`, seq: seq + 1, role: "assistant", text: result, preset: null, hasProposal: true, version: null, result: null, items: [], changes: [] },
  ];
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

/** 会話の高さ（箱の中で読める分だけ。続きは中でスクロールする）。 */
const THREAD_STYLE: CSSProperties = { maxHeight: 240, padding: 0, gap: 10 };

/** 作業の行（点を付けず、字下げだけ）。 */
const WORK_STYLE: CSSProperties = { margin: "6px 0 0", paddingLeft: 14, listStyle: "disc" };

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
  // このページの会話（開いたときに最新の会話を読み、頼むたびに続ける）
  const [pageId, setPageId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [thread, setThread] = useState<AiChatMessage[]>([]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
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
      if (target.ok) setPageId(target.pageId);
      else setBlocked(target.reason);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // このページの最後の会話を読んで続ける（読めなくても頼める。新しい会話として始まるだけ）
  useEffect(() => {
    if (!pageId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const newest = (await listAiChats(pageId, { signal: controller.signal }))[0];
        if (!newest) return;
        const chat = await getAiChat(pageId, newest.id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setConversationId(chat.conversation.id);
        setThread(chat.messages);
      } catch {
        // 履歴は手がかりで、頼むのに要らない（読めない理由は出さない）
      }
    })();
    return () => controller.abort();
  }, [pageId]);

  // 会話が伸びたら最後の発言まで送る
  useLayoutEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread]);

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
      const response = await proposeAiRequest(
        target.pageId,
        { baseRevision: target.revision, intent, ...(scope ? { scope } : {}), ...(conversationId ? { conversationId } : {}) },
        { signal: controller.signal },
      );
      setNearLimit(response.usage.nearLimit);
      const items = itemsOf(response.proposal);
      const result = items.length === 0 ? AI_TEXT.nothing : `提案が ${items.length} 件あります`;
      // やりとりはサーバーの会話に残っている。画面の会話にも同じ 2 つの発言を足す
      if (response.conversation) setConversationId(response.conversation.id);
      setThread((current) => [...current, ...turnOf(current, intent, result, response.conversation?.messageId ?? null)]);
      if (editedRef.current) {
        setMessage(AI_TEXT.stale);
        return;
      }
      if (items.length === 0) {
        setMessage(AI_TEXT.nothing);
        return;
      }
      setResult({ pageId: target.pageId, proposal: response.proposal, items, choices: {}, messageId: response.conversation?.messageId ?? null });
      setMessage(result);
    } catch (error) {
      await fail(error, "propose");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(null);
    }
  };

  /**
   * 自由入力は AI チャット（旧 NIHO docs と同じ動き）。候補（preset）の提案と違い、AI がページを直接書き換え、
   * 書いた分は版として残る（この箱から「元に戻す」で戻せる）。
   */
  const sendChat = async (value: string) => {
    if (busy || blocked || preparing) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy("working");
    setResult(null);
    setMessage(AI_TEXT.working);
    try {
      // 未保存の入力を先に保存し終えてから頼む（AI は保存された本文を読む）
      const target = await bridge.prepare();
      if (controller.signal.aborted) throw new AiRequestError("aborted");
      if (!target.ok) {
        setMessage(null);
        setBlocked(target.reason);
        return;
      }
      const answer = await sendAiChat(target.pageId, { text: value, ...(conversationId ? { conversationId } : {}) }, { signal: controller.signal });
      setNearLimit(answer.usage.nearLimit);
      if (answer.conversation) setConversationId(answer.conversation.id);
      setThread((current) => {
        const seq = (current.at(-1)?.seq ?? 0) + 1;
        return [
          ...current,
          { id: `ask-${seq}`, seq, role: "user", text: value, preset: null, hasProposal: false, version: null, result: null, items: [], changes: [] },
          {
            id: answer.conversation?.messageId ?? `result-${seq + 1}`,
            seq: seq + 1,
            role: "assistant",
            text: answer.reply,
            preset: null,
            hasProposal: false,
            version: null,
            result: answer.result,
            items: answer.items,
            changes: answer.changes,
          },
        ];
      });
      setText("");
      // 書き換えられたページを画面に載せる（自動保存は起こさない）
      if (answer.page) await bridge.replace(answer.page, { saved: true });
      setMessage(answer.result === "failed" ? AI_TEXT.chatFailed : answer.result === "stopped" ? AI_TEXT.stopped : answer.reply || AI_TEXT.done);
    } catch (error) {
      await fail(error, "propose");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(null);
    }
  };

  /** その依頼で書いた分を元に戻す（直したページは依頼の前へ、作ったページはゴミ箱へ）。 */
  const undo = async (messageId: string) => {
    if (busy) return;
    setBusy("undoing");
    setMessage(AI_TEXT.undoing);
    try {
      const target = await bridge.prepare();
      if (!target.ok) {
        setMessage(null);
        setBlocked(target.reason);
        return;
      }
      const answer = await undoAiChat(target.pageId, messageId);
      if (answer.page) await bridge.replace(answer.page, { saved: true });
      setThread((current) =>
        current.map((item) =>
          item.id === messageId
            ? { ...item, changes: item.changes.map((change) => (answer.undone.includes(change.pageId) ? { ...change, undoneAt: new Date().toISOString() } : change)) }
            : item,
        ),
      );
      setMessage(answer.undone.length > 0 ? AI_TEXT.undone : AI_TEXT.undoKept);
    } catch (error) {
      await fail(error, "adopt");
    } finally {
      setBusy(null);
    }
  };

  const sendText = () => {
    const value = text.trim();
    if (value.length === 0 || Array.from(value).length > MAX_CHAT_INPUT_CHARS) return;
    void sendChat(value);
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
      const { page, adopted } = await adoptAiRequest(current.pageId, {
        baseRevision: current.proposal.baseRevision,
        changes: chosen.flatMap((item) => (item.change ? [{ index: item.change.index, text: item.change.after }] : [])),
        inserts: chosen.flatMap((item) => (item.insert ? [{ afterIndex: item.insert.afterIndex, kind: item.insert.kind, text: item.insert.text }] : [])),
        ...(current.messageId ? { messageId: current.messageId } : {}),
      });
      await bridge.replace(page, { saved: true });
      onDone(aiDoneText(adopted?.version ?? null));
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
        {thread.length > 0 && (
          <div className="es-sh-sec" data-ai-thread="">
            <h3>{AI_TEXT.thread}</h3>
            <div ref={threadRef} className="es-thread" role="log" aria-label="AI との会話" style={THREAD_STYLE}>
              {thread.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="es-msg es-msg--me">
                    <div className="es-bb">{message.text}</div>
                  </div>
                ) : (
                  <div key={message.id} className="es-msg es-msg--ai">
                    <span className="es-mk" aria-hidden="true">
                      <Icon name="spark" />
                    </span>
                    <div className="es-bb">
                      {message.text}
                      {message.version !== null && (
                        <div className="es-tag-ok" data-ai-adopted="">
                          {aiAdoptedText(message.version)}
                        </div>
                      )}
                      {message.items.length > 0 && (
                        <ul className="es-sh-note es-sh-hint" data-ai-work="" style={WORK_STYLE}>
                          {message.items.map((item, position) => (
                            <li key={position}>{aiItemText(item)}</li>
                          ))}
                        </ul>
                      )}
                      {message.changes.length > 0 && (
                        <div className="es-card" data-ai-changes="">
                          {message.changes.map((change) => (
                            <div key={change.pageId} className={change.undoneAt ? "es-tag-no" : "es-tag-ok"} data-ai-change="">
                              {change.undoneAt ? `${aiChangeText(change)}（元に戻しました）` : aiChangeText(change)}
                            </div>
                          ))}
                          {message.changes.some((change) => change.undoneAt === null) && (
                            <div className="es-acts">
                              <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={busy !== null} onClick={() => void undo(message.id)}>
                                元に戻す
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
            <div className="es-acts">
              <button
                type="button"
                className="es-btn es-btn--quiet es-btn--sm"
                disabled={busy !== null}
                onClick={() => {
                  // 画面からも会話からも離れる（サーバーの会話は残る。次に頼むと新しい会話になる）
                  setConversationId(null);
                  setThread([]);
                }}
              >
                {AI_TEXT.fresh}
              </button>
            </div>
          </div>
        )}
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
                  aria-label="直したいこと・作りたいもの"
                  placeholder="直したいこと・作りたいもの…"
                  enterKeyHint="send"
                  maxLength={MAX_CHAT_INPUT_CHARS}
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
