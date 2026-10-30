import type { JSONContent } from "@tiptap/core";

/** 保存されている blocks を TipTap の doc にする（空のページは空の段落 1 つ）。 */
export function docFromBlocks(blocks: unknown[]): JSONContent {
  return { type: "doc", content: blocks.length > 0 ? (blocks as JSONContent[]) : [{ type: "paragraph" }] };
}
