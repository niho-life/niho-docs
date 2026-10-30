import {
  RECORDING_SEGMENT_TEXT_MAX_CHARS,
  RECORDING_TEXT_MAX_BYTES,
  isStorableText,
  recordingTextBytes,
  type RecordingData,
} from "@niho/editor-store";

/**
 * 文字起こしの段落をその場で直す（#36 段 1）。RecordingData を受けて新しい RecordingData を返す純粋な関数で、
 * editor-store の updateRecording の mutate にそのまま渡せる。変えるのは本文（text）だけで、時刻と話者はそのまま。
 */

/** 1 回の要求で直せる段落の数。 */
export const SEGMENT_EDITS_MAX = 200;

export type SegmentEdit = { index: number; text: string };
export type SegmentEditRejection = "index" | "text";

/**
 * 段落の本文を差し替える。改行は LF にそろえる（CRLF・CR → LF）。
 * - "index": edits が空か 200 を超える、index が整数でない・範囲の外・同じ index が 2 回
 * - "text": 文字列でない、5,000 文字を超える、NUL・対になっていない surrogate を含む、直した後の本文の合計が 8 MiB を超える
 */
export function editSegments(data: RecordingData, edits: readonly SegmentEdit[]): RecordingData | { rejected: SegmentEditRejection } {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > SEGMENT_EDITS_MAX) return { rejected: "index" };
  const segments = data.segments.slice();
  const seen = new Set<number>();
  for (const edit of edits) {
    const { index, text } = edit ?? {};
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= segments.length || seen.has(index)) {
      return { rejected: "index" };
    }
    seen.add(index);
    if (typeof text !== "string") return { rejected: "text" };
    const normalized = text.replace(/\r\n?/g, "\n");
    if (!isStorableText(normalized) || Array.from(normalized).length > RECORDING_SEGMENT_TEXT_MAX_CHARS) return { rejected: "text" };
    const segment = segments[index]!;
    segments[index] = { start: segment.start, end: segment.end, text: normalized, speaker: segment.speaker };
  }
  if (recordingTextBytes(segments) > RECORDING_TEXT_MAX_BYTES) return { rejected: "text" };
  return { segments, speakerNames: data.speakerNames };
}
