import type { AiModel, AiOutput, AiParagraph, AiRequest, AiResult } from "./model";

/**
 * 偽物のモデル（`EDITOR_AI_MODE=fake`。開発と CI だけ。本番では config.ts が受け付けない）。
 * 決定的で、返す文には必ず fake の印を入れる（本物の提案と見間違えないため）。usage の model は `fake`。
 *
 * - 整える: 連続する空白をまとめ、日本語の段落で句読点で終わらないものに「。」を足す（変わる段落だけ。先頭に `[fake] `）
 * - Tighten: 連続する空白をまとめる（変わる段落だけ。先頭に `[fake] `）
 * - 要約: 先頭（−1）に「要約（fake）: 最初の段落の先頭 30 文字…」の段落を足す（分けた要求ごとに 1 つ）
 * - 見出しをつける・Add headings: 最初の段落の前に見出し「見出し案（fake）」
 * - 記事にできそうな部分・Check facts to confirm: 最初の段落の後ろに囲みを足す
 * - 英語にする・日本語にする: 文のある各段落の先頭に `[fake EN] `・`[fake JA] `
 * - 自由入力: 最初の編集できる段落の末尾に「（直したいこと: 先頭 20 文字）」（先頭に `[fake] `）
 */

export const FAKE_MODEL_NAME = "fake";

const FAKE = "[fake] ";
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const ENDS_WITH_PUNCTUATION = /[。、．，！？!?」』）)…]$/u;

function head(text: string, length: number): string {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  return chars.length > length ? `${chars.slice(0, length).join("")}…` : chars.join("");
}

function collapse(text: string): string {
  return text.replace(/[ \t　]+/gu, " ").replace(/ *\n */gu, "\n").trim();
}

function tidy(paragraph: AiParagraph): string {
  const collapsed = collapse(paragraph.text);
  if (paragraph.kind === "paragraph" && JAPANESE.test(collapsed) && !ENDS_WITH_PUNCTUATION.test(collapsed)) return `${collapsed}。`;
  return collapsed;
}

function countChars(text: string): number {
  return Array.from(text).length;
}

function respond(request: AiRequest): AiOutput {
  const editable = request.paragraphs.filter((paragraph) => paragraph.kind !== "context");
  const first = request.paragraphs.find((paragraph) => paragraph.kind === "paragraph" && paragraph.text.trim().length > 0);
  const empty: AiOutput = { edits: [], inserts: [] };
  const intent = request.intent;
  if ("text" in intent) {
    const target = editable[0];
    if (!target) return empty;
    return { edits: [{ index: target.index, text: `${FAKE}${target.text}（直したいこと: ${head(intent.text, 20)}）` }], inserts: [] };
  }
  switch (intent.preset) {
    case "tidy":
    case "tighten": {
      const shape = intent.preset === "tidy" ? tidy : (paragraph: AiParagraph) => collapse(paragraph.text);
      const edits = editable.flatMap((paragraph) => {
        const text = shape(paragraph);
        return text !== paragraph.text && text.length > 0 ? [{ index: paragraph.index, text: `${FAKE}${text}` }] : [];
      });
      return { edits, inserts: [] };
    }
    case "toEnglish":
    case "toJapanese": {
      const mark = intent.preset === "toEnglish" ? "[fake EN] " : "[fake JA] ";
      const edits = editable.filter((paragraph) => paragraph.text.trim().length > 0).map((paragraph) => ({ index: paragraph.index, text: `${mark}${paragraph.text}` }));
      return { edits, inserts: [] };
    }
    case "summarize":
      if (!first) return empty;
      return { edits: [], inserts: [{ afterIndex: -1, kind: "paragraph", text: `要約（fake）: ${head(first.text, 30)}` }] };
    case "headings":
    case "addHeadings":
      if (!first) return empty;
      return { edits: [], inserts: [{ afterIndex: first.index - 1, kind: "heading", text: "見出し案（fake）" }] };
    case "articleIdeas":
    case "checkFacts": {
      if (!first) return empty;
      const label = intent.preset === "articleIdeas" ? "記事にできそうな部分（fake）" : "Check facts to confirm (fake)";
      return { edits: [], inserts: [{ afterIndex: first.index, kind: "callout", text: `${label}: ${head(first.text, 30)}` }] };
    }
  }
}

/** 決定的な偽物のモデル。usage は送った文字数・返した文字数の 1/4（切り上げ）。 */
export function createFakeModel(): AiModel {
  return {
    async run(request: AiRequest, signal?: AbortSignal): Promise<AiResult> {
      signal?.throwIfAborted();
      const output = respond(request);
      const sent = request.paragraphs.reduce((sum, paragraph) => sum + countChars(paragraph.text), 0);
      const returned = [...output.edits, ...output.inserts].reduce((sum, item) => sum + countChars(item.text), 0);
      return { output, usage: { model: FAKE_MODEL_NAME, inputTokens: Math.ceil(sent / 4), outputTokens: Math.ceil(returned / 4) } };
    },
  };
}
