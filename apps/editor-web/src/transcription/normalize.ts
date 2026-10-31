import {
  RECORDING_SEGMENTS_MAX,
  RECORDING_SEGMENT_TEXT_MAX_CHARS,
  RECORDING_TEXT_MAX_BYTES,
  recordingDataProblem,
  recordingTextBytes,
  type RecordingSegment,
} from "@niho/editor-store";
import { EngineError, type EngineResult } from "./engine";

/**
 * エンジンの生の結果を、録音の段落の保存の形（packages/editor-store の recordings.ts の規則）にする純粋な関数（#36 段 2b）。
 *
 * - 本文: 改行・タブは空白に、それ以外の制御文字・NUL・対になっていない surrogate は取り除き、前後の空白を除く。空になった段落は捨てる。
 * - 時刻: 0 以上の有限の数だけ（終わりが始まりより前なら始まりに揃える。始まりが読めなければ両方 null）。
 * - 並び: 始まりの時刻の順（同じ時刻・時刻の無い段落は元の順のまま。時刻の無い段落は後ろ）。
 * - 話者: 並べたあとに最初に出た順で 1, 2, 3…（Deepgram は 0 始まり）。話者を分けない（diarize: false）・番号の無い段落は null。
 * - 長い段落: 5,000 文字を超えたら、「。」「．」「.」「！」「？」（と半角の「!」「?」）の後ろ → 空白 → 文字数 の順に割る。
 *   割った段落の時刻は、元の段落の時間を文字数で按分する（ミリ秒に丸める）。
 * - 上限: 段落が 20,000 個・本文の合計が 8 MiB（録音の保存の上限と同じ定数）を超えたら EngineError("too_large")。
 */

const SENTENCE_END = new Set(["。", "．", ".", "！", "？", "!", "?"]);
const WHITESPACE = /\s/u;
const LINE_BREAKS = /[\r\n\t\u2028\u2029]+/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

export type NormalizeOptions = { diarize: boolean };
export type NormalizedResult = { segments: RecordingSegment[]; durationSec: number | null };

type Draft = { start: number | null; end: number | null; text: string; rawSpeaker: unknown; order: number };

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(LONE_SURROGATE, "").replace(LINE_BREAKS, " ").replace(CONTROL, "").trim();
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function times(start: unknown, end: unknown): [number | null, number | null] {
  if (!isTime(start)) return [null, null];
  return [start, isTime(end) && end >= start ? end : start];
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 5,000 文字（code point）ごとに割る。文の終わり → 空白 → 文字数 の順に割る位置を探す。 */
export function splitLongText(text: string, maxChars: number = RECORDING_SEGMENT_TEXT_MAX_CHARS): string[] {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text.length > 0 ? [text] : [];
  const pieces: string[] = [];
  let offset = 0;
  while (chars.length - offset > maxChars) {
    const limit = offset + maxChars;
    let cut = -1;
    for (let index = limit - 1; index > offset; index--) {
      if (SENTENCE_END.has(chars[index]!)) {
        cut = index + 1;
        break;
      }
    }
    if (cut < 0) {
      for (let index = limit - 1; index > offset; index--) {
        if (WHITESPACE.test(chars[index]!)) {
          cut = index;
          break;
        }
      }
    }
    if (cut < 0) cut = limit;
    const piece = chars.slice(offset, cut).join("").trim();
    if (piece) pieces.push(piece);
    offset = cut;
    while (offset < chars.length && WHITESPACE.test(chars[offset]!)) offset++;
  }
  const last = chars.slice(offset).join("").trim();
  if (last) pieces.push(last);
  return pieces;
}

function tooLarge(): EngineError {
  return new EngineError("too_large");
}

/** エンジンの生の結果 → 保存の形。上限を超えたら EngineError("too_large")、正規化しても規則に合わなければ EngineError("bad_response")。 */
export function normalizeEngineResult(result: EngineResult, options: NormalizeOptions): NormalizedResult {
  if (!result || !Array.isArray(result.segments)) throw new EngineError("bad_response");
  // 割ると段落は増えるだけなので、割る前に上限を超えていれば先に断る（大きな結果で余計な仕事をしない）
  if (result.segments.length > RECORDING_SEGMENTS_MAX * 4) throw tooLarge();

  const drafts: Draft[] = [];
  result.segments.forEach((segment, order) => {
    if (typeof segment !== "object" || segment === null) return;
    const text = cleanText(segment.text);
    if (!text) return;
    const [start, end] = times(segment.start, segment.end);
    drafts.push({ start, end, text, rawSpeaker: segment.speaker, order });
  });
  if (drafts.length > RECORDING_SEGMENTS_MAX) throw tooLarge();
  if (recordingTextBytes(drafts) > RECORDING_TEXT_MAX_BYTES) throw tooLarge();

  drafts.sort((a, b) => (a.start ?? Number.POSITIVE_INFINITY) - (b.start ?? Number.POSITIVE_INFINITY) || a.order - b.order);

  const speakers = new Map<number, number>();
  const segments: RecordingSegment[] = [];
  for (const draft of drafts) {
    let speaker: number | null = null;
    const raw = draft.rawSpeaker;
    if (options.diarize && typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
      speaker = speakers.get(raw) ?? speakers.size + 1;
      speakers.set(raw, speaker);
    }
    const pieces = splitLongText(draft.text);
    if (pieces.length === 1 || draft.start === null || draft.end === null) {
      for (const text of pieces) segments.push({ start: draft.start, end: draft.end, text, speaker });
    } else {
      const total = pieces.reduce((sum, piece) => sum + Array.from(piece).length, 0);
      const span = draft.end - draft.start;
      let done = 0;
      for (const text of pieces) {
        const length = Array.from(text).length;
        const start = roundMs(draft.start + (span * done) / total);
        done += length;
        const end = Math.max(start, roundMs(draft.start + (span * done) / total));
        segments.push({ start, end, text, speaker });
      }
    }
    if (segments.length > RECORDING_SEGMENTS_MAX) throw tooLarge();
  }
  if (recordingTextBytes(segments) > RECORDING_TEXT_MAX_BYTES) throw tooLarge();
  if (recordingDataProblem({ segments, speakerNames: {} })) throw new EngineError("bad_response");
  return { segments, durationSec: isTime(result.durationSec) ? result.durationSec : null };
}
