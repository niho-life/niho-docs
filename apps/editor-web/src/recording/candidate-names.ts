import { RECORDING_CANDIDATE_NAME_MAX_CHARS } from "@niho/editor-store";

/**
 * 文字起こしの案の名前（#36 段 3b-4）。旧 NIHO docs の candidates.ts の sourceCandidateName と同じ規則:
 * **エンジンの名前**。同じ名前の案があれば「Deepgram 2」のように数を足す（エンジンは案の一意キーにしない）。
 * 画面に出すエンジンの名前も、設定・案の名前・一覧で同じものを使う。
 */

/** エンジンの id → 画面の名前。知らないエンジン（あとで増えるもの）は id をそのまま出す。 */
const ENGINE_LABELS: Readonly<Record<string, string>> = {
  deepgram: "Deepgram",
  fake: "開発の偽物",
  "vtt-import": "取り込んだ字幕",
  gemini: "Gemini",
  "this-mac": "この Mac",
};

export function candidateEngineLabel(engine: string | null): string {
  if (engine === null) return "文字起こし";
  return ENGINE_LABELS[engine] ?? engine;
}

/** 1 つ目の案（いまの文字起こし）に付ける名前。何で作ったか分からない録音は「はじめの案」。 */
export function primaryCandidateName(engine: string | null): string {
  return engine === null ? "はじめの案" : candidateEngineLabel(engine);
}

/** 新しい案の名前（エンジンの名前。同じ名前があれば 2・3… を足す）。 */
export function nextCandidateName(existing: readonly string[], engine: string): string {
  const label = candidateEngineLabel(engine);
  const names = new Set(existing);
  if (!names.has(label)) return label;
  for (let n = 2; ; n += 1) {
    const name = `${label} ${n}`;
    // 名前の上限（store の CHECK と同じ）を超えないよう、長いエンジン名は数だけで区別する
    if (Array.from(name).length > RECORDING_CANDIDATE_NAME_MAX_CHARS) return `案 ${n}`;
    if (!names.has(name)) return name;
  }
}
