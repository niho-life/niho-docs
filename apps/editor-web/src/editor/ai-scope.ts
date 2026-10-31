import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { AiScope } from "@/ai/engine";

/** 文字の無いノード（区切り線・改行）を中身として数えるための文字。 */
const LEAF = "\ufffc";

/** 本文の中の範囲（ProseMirror の位置）。 */
export type SelectionRange = { from: number; to: number };

/** 選んだ文字の範囲。選択が無い（カーソルだけ）ときは null（ページ全体に頼む）。 */
export function selectionRange(state: EditorState): SelectionRange | null {
  const { selection } = state;
  return selection.empty ? null : { from: selection.from, to: selection.to };
}

/**
 * 範囲を AI に頼む範囲（最上位のブロックの index の範囲。`toIndex` を含む）にする。サーバーの `scope` と同じ形。
 *
 * - リストや引用の中の選択は、それを含む最上位のブロック（リスト・引用の全体）。
 * - 終わりが次のブロックの先頭・始まりが前のブロックの末尾（そのブロックの文字を 1 つも含まない。段落を行ごと選んだときなど）なら、
 *   そのブロックは入れない。
 * - 範囲が潰れた（選んだ文字を消した）ときは、その位置のブロック 1 つ。null はページ全体（undefined）。
 */
export function aiScopeOf(doc: ProseMirrorNode, range: SelectionRange | null): AiScope | undefined {
  if (!range || doc.childCount === 0) return undefined;
  const size = doc.content.size;
  const from = Math.max(0, Math.min(range.from, range.to, size));
  const to = Math.min(size, Math.max(range.from, range.to, 0));
  const last = doc.childCount - 1;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const empty = (start: number, end: number) => doc.textBetween(start, end, undefined, LEAF) === "";
  let fromIndex = Math.min($from.index(0), last);
  let toIndex = Math.min($to.index(0), last);
  if (toIndex > fromIndex && empty($to.posAtIndex(toIndex, 0), to)) toIndex -= 1;
  if (toIndex > fromIndex && empty(from, $from.posAtIndex(fromIndex + 1, 0))) fromIndex += 1;
  return { fromIndex, toIndex };
}
