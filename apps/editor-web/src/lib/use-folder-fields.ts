"use client";

import { useCallback, useEffect, useState } from "react";
import { formatVariants, parseVariants } from "@niho/docs-core";
import type { EditorSettingsEntityDraft, EditorSettingsTermDraft } from "niho-docs-ui/shell";
import { loadPageFields, savePageFieldsRequest } from "./folder-client";
import { FOLDER_FIELD_LIMITS } from "./page-limits";

/**
 * 情報パネルの「このフォルダの背景」（#37）。登場人物と固有名詞を読み、編集を開いているあいだは打った文字を持つ。
 *
 * - 読むのはページを開いて節を出すときだけ（フォルダでないページ・レールを閉じているあいだは読まない）。
 * - **読み終えるまで編集も保存もさせない**。読む前に編集を開くと、編集画面が空の値で始まり、保存が登場人物・固有名詞を
 *   丸ごと置き換えて既存の値を消す。読めなかったときも空のフォルダとして保存させない（押すと読み直す）。
 * - 誤りやすい表記は打ったままの文字列で持ち、保存のときに配列にする（設定の画面と同じ決まり）。
 * - 保存できなければサーバーが持っている値に戻して一言（画面とサーバーを食い違わせない）。
 */

/** 画面が持つフォルダの欄（サーバーの `PageFields` を、打ったままの文字列で持つ形にしたもの）。 */
type Drafts = { entities: EditorSettingsEntityDraft[]; terms: EditorSettingsTermDraft[] };

export type FolderFieldsState = Drafts & {
  open: boolean;
  busy: boolean;
  note: string | null;
  max: { entities: number; terms: number };
  onOpen: () => void;
  onEntities: (next: EditorSettingsEntityDraft[]) => void;
  onTerms: (next: EditorSettingsTermDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
};

/** サーバーの値を読んだか（読み終えるまで編集も保存もさせない）。 */
type Loaded = "loading" | "ready" | "failed";

const LOADING_NOTE = "読み込んでいます。少し待ってから、もう一度押してください";
const FAILED_NOTE = "読み込めませんでした。もう一度押すと読み直します";

type State = {
  /** いま読んでいるページ（変わったら作り直す）。 */
  pageId: string | null;
  loaded: Loaded;
  /** サーバーが持っている値。 */
  saved: Drafts;
  /** 編集しているあいだの値。 */
  drafts: Drafts;
  open: boolean;
  busy: boolean;
  note: string | null;
};

const EMPTY: Drafts = { entities: [], terms: [] };

function freshState(pageId: string | null): State {
  return { pageId, loaded: "loading", saved: EMPTY, drafts: EMPTY, open: false, busy: false, note: null };
}

function draftsOf(fields: { entities: EditorSettingsEntityDraft[]; terms: { term: string; reading: string; variants: string[]; note: string }[] }): Drafts {
  return {
    entities: fields.entities.map((entity) => ({ ...entity })),
    terms: fields.terms.map((term) => ({ term: term.term, reading: term.reading, variants: formatVariants(term.variants), note: term.note })),
  };
}

export function useFolderFields(pageId: string | null): FolderFieldsState {
  const [state, setState] = useState<State>(() => freshState(pageId));
  // ページが変わったら作り直す（描くときに合わせる。effect の中で setState しない）
  if (state.pageId !== pageId) setState(freshState(pageId));
  // 読めなかったあとに押されたら読み直す（数が変わると effect が走り直す）
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (pageId === null) return;
    let alive = true;
    void loadPageFields(pageId)
      .then((read) => {
        if (!alive) return;
        const drafts = draftsOf(read);
        setState((current) => (current.pageId === pageId ? { ...current, loaded: "ready", saved: drafts, drafts, note: null } : current));
      })
      .catch(() => {
        if (!alive) return;
        setState((current) => (current.pageId === pageId ? { ...current, loaded: "failed", note: FAILED_NOTE } : current));
      });
    return () => {
      alive = false;
    };
  }, [pageId, attempt]);

  const onSave = useCallback(() => {
    if (pageId === null) return;
    setState((current) => {
      // 読み終えていない値の上に保存しない（編集を開けないので届かないが、取りこぼしても既存の値を消さない）
      if (current.busy || current.loaded !== "ready") return current;
      const patch = {
        entities: current.drafts.entities.filter((entity) => entity.name.trim() !== ""),
        terms: current.drafts.terms
          .filter((term) => term.term.trim() !== "")
          .map((term) => ({ term: term.term, reading: term.reading, variants: parseVariants(term.variants), note: term.note })),
      };
      void savePageFieldsRequest(pageId, patch)
        .then((fields) => {
          const drafts = draftsOf(fields);
          setState((now) => (now.pageId === pageId ? { ...now, saved: drafts, drafts, open: false, busy: false, note: null } : now));
        })
        .catch(() => {
          setState((now) => (now.pageId === pageId ? { ...now, drafts: now.saved, busy: false, note: "保存できませんでした。もう一度試してください" } : now));
        });
      return { ...current, busy: true, note: null };
    });
  }, [pageId]);

  const shown = state.open ? state.drafts : state.saved;
  return {
    entities: shown.entities,
    terms: shown.terms,
    open: state.open,
    busy: state.busy,
    note: state.note,
    max: FOLDER_FIELD_LIMITS,
    onOpen: () => {
      if (state.loaded === "ready") {
        setState((current) => ({ ...current, drafts: current.saved, open: true, note: null }));
        return;
      }
      if (state.loaded === "failed") {
        setState((current) => ({ ...current, loaded: "loading", note: LOADING_NOTE }));
        setAttempt((count) => count + 1);
        return;
      }
      setState((current) => ({ ...current, note: LOADING_NOTE }));
    },
    onEntities: (next) => setState((current) => ({ ...current, drafts: { ...current.drafts, entities: next } })),
    onTerms: (next) => setState((current) => ({ ...current, drafts: { ...current.drafts, terms: next } })),
    onCancel: () => setState((current) => ({ ...current, drafts: current.saved, open: false, note: null })),
    onSave,
  };
}
