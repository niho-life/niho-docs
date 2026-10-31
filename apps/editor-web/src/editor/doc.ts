import type { Editor, JSONContent } from "@tiptap/core";

/** 保存されている blocks を TipTap の doc にする（空のページは空の段落 1 つ）。 */
export function docFromBlocks(blocks: unknown[]): JSONContent {
  return { type: "doc", content: blocks.length > 0 ? (blocks as JSONContent[]) : [{ type: "paragraph" }] };
}

/**
 * 本文を blocks に差し替える（端末の下書き・AI の採用の結果・競合の応答のページ）。今の schema で読めなければ載せずに false。
 * 載せたこと自体は Undo の対象にしない（直後の Undo で載せた本文を消さない）。onUpdate（自動保存・下書き）も起こさない。
 */
export function replaceBlocks(editor: Editor, blocks: unknown[]): boolean {
  const doc = docFromBlocks(blocks);
  try {
    editor.schema.nodeFromJSON(doc).check();
  } catch {
    return false;
  }
  editor.chain().setMeta("addToHistory", false).setContent(doc, { emitUpdate: false }).run();
  return true;
}
