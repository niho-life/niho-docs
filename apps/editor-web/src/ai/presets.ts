import type { PageKind, PageLang } from "@niho/editor-store";

/**
 * AI に頼むこと（設計 §6）。ページの種類ごとの候補（preset）か、自由入力の「直したいこと」。
 *
 * - `edit`: 既存の文を変える提案（差分で見せる）。
 * - `insert`: 足すだけの提案（要約・見出し案など）。モデルが edits を返してもエンジンが捨てる（既存の文は変えない）。
 *
 * 録音の「記事にする」「議事録にする」は #37 の手順の起動で、ここでは扱わない。
 */
export const PRESET_IDS = [
  "tidy",
  "summarize",
  "articleIdeas",
  "headings",
  "toEnglish",
  "tighten",
  "addHeadings",
  "toJapanese",
  "checkFacts",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type PresetMode = "edit" | "insert";

export type Preset = { id: PresetId; label: string; mode: PresetMode };

/** 自由入力の「直したいこと」の上限（文字）。 */
export const MAX_INTENT_TEXT_CHARS = 500;

export type AiIntent = { preset: PresetId } | { text: string };

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  tidy: { id: "tidy", label: "整える", mode: "edit" },
  summarize: { id: "summarize", label: "要約", mode: "insert" },
  articleIdeas: { id: "articleIdeas", label: "記事にできそうな部分", mode: "insert" },
  headings: { id: "headings", label: "見出しをつける", mode: "insert" },
  toEnglish: { id: "toEnglish", label: "英語にする", mode: "edit" },
  tighten: { id: "tighten", label: "Tighten", mode: "edit" },
  addHeadings: { id: "addHeadings", label: "Add headings", mode: "insert" },
  toJapanese: { id: "toJapanese", label: "日本語にする", mode: "edit" },
  checkFacts: { id: "checkFacts", label: "Check facts to confirm", mode: "insert" },
};

const NOTE: readonly PresetId[] = ["tidy", "summarize", "headings", "toEnglish"];

/**
 * ページの種類と言語ごとの候補（後段の画面が読む）。並びは画面の並び。
 * 日本語の記事はメモと同じ候補、手順は候補なし（自由入力だけ）。
 */
export function presetsFor(kind: PageKind, lang: PageLang): Preset[] {
  const ids: readonly PresetId[] =
    kind === "note"
      ? NOTE
      : kind === "article"
        ? lang === "en"
          ? ["tighten", "addHeadings", "toJapanese", "checkFacts"]
          : NOTE
        : kind === "rec"
          ? ["summarize"]
          : [];
  return ids.map((id) => PRESETS[id]);
}

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

/** 自由入力は edits と inserts の両方を受ける。 */
export function intentMode(intent: AiIntent): PresetMode {
  return "preset" in intent ? PRESETS[intent.preset].mode : "edit";
}

/** 提案の上に出す名前（preset の名前か、直したいことそのもの）。 */
export function intentLabel(intent: AiIntent): string {
  return "preset" in intent ? PRESETS[intent.preset].label : intent.text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 要求の `intent`。`{ preset }`（知っている id）か `{ text }`（前後の空白を除いて 1〜500 文字・NUL なし）のどちらか 1 つ。 */
export function parseIntent(value: unknown): AiIntent | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (keys[0] === "preset") return isPresetId(value.preset) ? { preset: value.preset } : null;
  if (keys[0] !== "text" || typeof value.text !== "string") return null;
  const text = value.text.trim();
  const length = Array.from(text).length;
  if (length === 0 || length > MAX_INTENT_TEXT_CHARS || text.includes("\u0000")) return null;
  return { text };
}
