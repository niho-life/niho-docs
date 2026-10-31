import type { AnthropicClient, CompleteInput, Completion } from "./anthropic";

/**
 * 偽物の 1 往復（`EDITOR_AI_MODE=fake`。開発と CI だけ。本番では config.ts が受け付けない）。
 * 決定的で、返す文には必ず `[fake]` の印を入れる（本物の文書と見間違えないため）。usage の model は `fake`。
 *
 * 返すのは compose.ts が読める JSON（見出し 1 つと段落 2 つ）。プロンプトの中身は読まず、
 * 「## 頼むこと」の次の行（手順と段階の名前）と資料の先頭だけを写す。
 */

export const FAKE_CLIENT_MODEL = "fake";

/** プロンプトから印として写す部分の長さ（文字）。 */
const HEAD_CHARS = 60;

function head(text: string, length: number): string {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  return chars.length > length ? `${chars.slice(0, length).join("")}…` : chars.join("");
}

/** 「## 頼むこと」の次の行（無ければ空）。 */
function askedFor(user: string): string {
  const lines = user.split("\n");
  const position = lines.indexOf("## 頼むこと");
  return position >= 0 ? (lines[position + 1] ?? "") : "";
}

/** 資料（`<untrusted_data>` の中）の先頭（無ければ空）。 */
function sourceHead(user: string): string {
  const match = /<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/.exec(user);
  return match?.[1] ?? "";
}

function countChars(text: string): number {
  return Array.from(text).length;
}

/** 決定的な偽物の 1 往復。usage は送った文字数・返した文字数の 1/4（切り上げ）。 */
export function createFakeClient(): AnthropicClient {
  return {
    async complete(input: CompleteInput): Promise<Completion> {
      input.signal?.throwIfAborted();
      const asked = head(askedFor(input.user), HEAD_CHARS) || "（頼むことなし）";
      const source = head(sourceHead(input.user), HEAD_CHARS) || "（資料なし）";
      const text = JSON.stringify({
        blocks: [
          { kind: "heading", level: 2, text: "[fake] 偽の結果" },
          { kind: "paragraph", text: `[fake] ${asked}` },
          { kind: "paragraph", text: `[fake] 資料の先頭: ${source}` },
        ],
      });
      const sent = countChars(input.system) + countChars(input.user);
      return { text, usage: { model: FAKE_CLIENT_MODEL, inputTokens: Math.ceil(sent / 4), outputTokens: Math.ceil(countChars(text) / 4) } };
    },
  };
}
