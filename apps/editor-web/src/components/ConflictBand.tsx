"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { docFromBlocks } from "@/editor/doc";
import { buildPageExtensions } from "@/editor/page-extensions";
import type { ConflictPage } from "@/lib/pages-client";

/** 競合の応答の保存時刻を、端末のローカル時刻の HH:mm にする（読めなければ null）。 */
export function clockOf(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function conflictMessage(page: ConflictPage): string {
  const clock = clockOf(page.updatedAt);
  return clock ? `${clock} に別の画面で保存されました` : "別の画面で保存されました";
}

type CopyResult = "copied" | "failed" | null;

/**
 * 別の画面・端末が先に保存していたときの帯（設計 §12）。本文の編集は止めず、自分の文章を失う操作を既定にしない
 * （どのボタンも Enter の既定の動作にはせず、開いても自動でフォーカスしない）。
 * - 最新版を見る: 競合の応答のページを読み取り専用で出す（自分の本文は変えない）。
 * - 本文をコピー: 自分の題名と本文をプレーンテキストで clipboard へ。
 * - この内容で上書き: 自分の題名・本文を、最新の revision の上に `overwrite: true` で送る（上書きされる本文は版に残る）。
 * 見た目の作り込みは #48。ここでは最小限のマークアップだけを置く。
 */
export function ConflictBand(props: {
  page: ConflictPage;
  /** 上書きを送っている最中。 */
  overwriting: boolean;
  /** ダイアログを置く場所（`data-docs-app-root` の中に置いてスタイルの規約に入れる）。 */
  container: HTMLElement | null;
  onCopy: () => Promise<boolean>;
  onOverwrite: () => void;
}) {
  const [viewing, setViewing] = useState(false);
  const [copied, setCopied] = useState<CopyResult>(null);
  return (
    <div data-conflict-band="">
      <div role="alert">
        <p>{conflictMessage(props.page)}</p>
        <button type="button" onClick={() => setViewing(true)}>
          最新版を見る
        </button>
        <button
          type="button"
          onClick={async () => {
            setCopied(null);
            setCopied((await props.onCopy()) ? "copied" : "failed");
          }}
        >
          本文をコピー
        </button>
        <button type="button" disabled={props.overwriting} onClick={props.onOverwrite}>
          この内容で上書き
        </button>
      </div>
      <p aria-live="polite" data-copy-result={copied ?? ""}>
        {copied === "copied" ? "本文をコピーしました" : copied === "failed" ? "コピーできませんでした" : ""}
      </p>
      <Dialog.Root open={viewing} onOpenChange={setViewing}>
        <Dialog.Portal container={props.container ?? undefined}>
          <Dialog.Overlay />
          <Dialog.Content aria-describedby={undefined} data-latest-page="">
            <Dialog.Title>最新版（{conflictMessage(props.page)}）</Dialog.Title>
            <p data-latest-title="">
              <strong>{props.page.title || "無題"}</strong>
            </p>
            <ReadOnlyBody blocks={props.page.blocks} />
            <Dialog.Close asChild>
              <button type="button">閉じる</button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** 最新版の本文（同じ schema の読み取り専用の TipTap）。 */
function ReadOnlyBody(props: { blocks: unknown[] }) {
  const [unreadable, setUnreadable] = useState(false);
  const editor = useEditor(
    {
      extensions: buildPageExtensions(),
      content: docFromBlocks(props.blocks),
      editable: false,
      immediatelyRender: false,
      enableContentCheck: true,
      onContentError: () => setUnreadable(true),
      editorProps: { attributes: { class: "doc", "aria-label": "最新版の本文", "aria-readonly": "true" } },
    },
    [props.blocks],
  );
  if (unreadable) return <p>この本文はここでは表示できません。</p>;
  return (
    <div className="be">
      <EditorContent editor={editor} />
    </div>
  );
}
