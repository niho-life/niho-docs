"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/editor.css";
import { useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { useEditor, type Editor } from "@tiptap/react";
import { BlockEditor, PageTitle } from "niho-docs-ui/components/BlockEditor";
import { ENABLED_INPUT_RULES, buildBlockEditorExtensions } from "niho-docs-ui/lib/block-editor/index";
import { createAutosave, type Autosave, type SaveState } from "@/lib/autosave";
import { MAX_TITLE_CHARS } from "@/lib/page-limits";
import { savePageRequest, type PageBody } from "@/lib/pages-client";

export type EditablePage = {
  id: string;
  title: string;
  blocks: unknown[];
};

const STATE_TEXT: Record<SaveState, string> = {
  saved: "保存済み",
  saving: "保存中",
  error: "保存に失敗",
};

/** 保存されている blocks を TipTap の doc にする（空のページは空の段落 1 つ）。 */
export function docFromBlocks(blocks: unknown[]): JSONContent {
  return { type: "doc", content: blocks.length > 0 ? (blocks as JSONContent[]) : [{ type: "paragraph" }] };
}

/**
 * ページの題名と本文。本文は niho-docs-ui の BlockEditor（TipTap）。blocks は TipTap の doc の content（ブロックの配列）をそのまま保存する。
 * 入力の 1 秒後に PATCH で自動保存し、状態を文字で読み上げる。
 */
export function PageEditor(props: { page: EditablePage }) {
  const { page } = props;
  const [title, setTitle] = useState(page.title);
  const [state, setState] = useState<SaveState>("saved");
  const [unreadable, setUnreadable] = useState(false);
  const [titleClamped, setTitleClamped] = useState(false);
  const unreadableRef = useRef(false);
  const composingRef = useRef(false);

  const autosaveRef = useRef<Autosave<PageBody> | null>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    const autosave = createAutosave<PageBody>({
      save: (patch) => savePageRequest(page.id, patch),
      isComposing: () => composingRef.current || Boolean(editorRef.current?.view.composing),
      onState: setState,
    });
    autosaveRef.current = autosave;
    return () => {
      // 画面を離れるとき（一覧へ戻るなど）は 1 秒を待たずに保存を送る
      void autosave.flush();
      autosave.dispose();
    };
  }, [page.id]);

  const editor = useEditor({
    extensions: buildBlockEditorExtensions(),
    enableInputRules: ENABLED_INPUT_RULES,
    content: docFromBlocks(page.blocks),
    // サーバーで描かずにブラウザで作る（hydration のずれを避ける）
    immediatelyRender: false,
    // 読めない本文を空として上書きしない
    enableContentCheck: true,
    onContentError: () => {
      unreadableRef.current = true;
      setUnreadable(true);
    },
    editorProps: { attributes: { class: "doc", "aria-label": "本文" } },
    onUpdate: ({ editor: current }) => {
      if (unreadableRef.current) return;
      autosaveRef.current?.change({ blocks: current.getJSON().content ?? [] });
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (editor && unreadable) editor.setEditable(false, false);
  }, [editor, unreadable]);

  return (
    <div
      data-docs-app-root=""
      data-docs-shared-ui=""
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
    >
      <p role="status" aria-live="polite" data-save-state={state}>
        {STATE_TEXT[state]}
      </p>
      <PageTitle
        value={title}
        editor={editor}
        onChange={(input) => {
          // サーバーが受けない長さの題名を自動保存に載せない（失敗した変更は残って本文の保存も止めるため）。上限で止めて知らせる
          const chars = Array.from(input);
          const value = chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("") : input;
          setTitleClamped(value !== input);
          setTitle(value);
          autosaveRef.current?.change({ title: value });
        }}
      />
      {titleClamped && <p role="status">題名は {MAX_TITLE_CHARS} 字までです。</p>}
      {unreadable && <p role="alert">本文を読み込めませんでした。この画面では本文を変更しません。</p>}
      <BlockEditor editor={editor} />
    </div>
  );
}
