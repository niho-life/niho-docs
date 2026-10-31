import {
  RECORDING_SEGMENTS_MAX,
  RECORDING_SEGMENT_TEXT_MAX_CHARS,
  RECORDING_TEXT_MAX_BYTES,
  recordingDataProblem,
  recordingTextBytes,
  type RecordingData,
  type RecordingSegment,
} from "@niho/editor-store";
import { SpeakerNameIndex, listSpeakers } from "./speakers";

/**
 * 1 つの録音ページに、あとの音声・字幕の文字起こしを足す（#36 段 3b-3「複数音声」）。
 * RecordingData を受けて新しい RecordingData を返す純粋な関数で、editor-store の updateRecording の mutate にそのまま渡せる。
 *
 * - 時刻は **前の音声の長さだけずらす**（docs-core の audio-transcription.ts と同じ規則）。ずらす量は、録音の長さ（durationSec。
 *   音声そのものの長さ）と、ここまでの段落の末尾のうち大きいほう（字幕が音声より長いときに重ならないため）。
 *   時刻を持たない段落（start・end が null）は、そのまま時刻なしで足す。
 * - 録音の長さは「ずらす量 ＋ 足す側の長さ」に伸ばす（次に足すときのずらす量になる。store の duration_sec に入る）。
 * - 話者の番号は、今ある番号の後ろに続けて振り直す。ただし **足す側の名前が今ある話者の表示名とそのまま同じなら、その話者に寄せる**
 *   （同じ人が続けて話している録音の 2 本目。docs-core の規則が同じ表示名の話者を 2 人作らせないため、番号を分けると名前を失う）。
 *   名前が規則に合わない（空・「話者N」の形・ほかと同じに見える）ときは、名前を付けずに番号だけで足す（段落は失わない）。
 * - 断る理由: append_empty（足す段落が無い）・append_too_large（段落の数・1 段落の文字数・本文の合計が上限を超える）・
 *   append_invalid（足す側の時刻・文字・話者の形が規則に合わない）。断ったときは何も変えない。
 */

export type AppendRejection = "append_empty" | "append_too_large" | "append_invalid";

/** 足す側（音声 1 本・字幕 1 つ）の文字起こし。時刻はその音声の先頭を 0 とした秒。 */
export type AppendSource = {
  segments: readonly RecordingSegment[];
  /** 話者番号（10 進の文字列）から名前。足す側の番号で引く。 */
  speakerNames: Readonly<Record<string, string>>;
  /** 足す音声・字幕の長さ（秒）。分からなければ null（段落の末尾を長さとみなす）。 */
  durationSec: number | null;
};

/** 段落の末尾のうち最も後ろ（秒）。時刻の無い段落しかなければ 0。 */
export function transcriptEndSec(segments: readonly RecordingSegment[]): number {
  let end = 0;
  for (const segment of segments) {
    if (segment.end !== null && Number.isFinite(segment.end)) end = Math.max(end, segment.end);
  }
  return end;
}

/** 次に足すときにずらす量（秒）。録音の長さと、ここまでの段落の末尾のうち大きいほう。 */
export function appendOffsetSec(data: Pick<RecordingData, "segments" | "durationSec">): number {
  const duration = typeof data.durationSec === "number" && Number.isFinite(data.durationSec) && data.durationSec > 0 ? data.durationSec : 0;
  return Math.max(duration, transcriptEndSec(data.segments));
}

function shift(segment: RecordingSegment, offsetSec: number): RecordingSegment {
  if (segment.start === null || segment.end === null) return { start: null, end: null, text: segment.text, speaker: segment.speaker };
  return { start: segment.start + offsetSec, end: segment.end + offsetSec, text: segment.text, speaker: segment.speaker };
}

/** 今ある話者の番号のうち最も大きいもの（段落にも名前の表にも無ければ 0）。 */
function lastSpeaker(data: RecordingData): number {
  let last = 0;
  for (const { speaker } of listSpeakers(data)) last = Math.max(last, speaker);
  return last;
}

/** 足す側の話者番号 → この録音の話者番号。 */
function mapSpeakers(data: RecordingData, source: AppendSource): { numbers: Map<number, number>; speakerNames: Record<string, string> } {
  const existing = listSpeakers(data);
  // 今ある表示名（名前か「話者N」）から話者番号。同じ名前の人に寄せるために引く
  const byName = new Map<string, number>();
  for (const { speaker, name } of existing) {
    if (name !== null) byName.set(name.trim().normalize("NFKC"), speaker);
  }
  const names = new SpeakerNameIndex(existing);
  const speakerNames = { ...data.speakerNames };
  const numbers = new Map<number, number>();
  let next = lastSpeaker(data);
  // 足す側の番号の順（字幕・エンジンは初出の順に番号を振る）に見る
  const sources = [...new Set(source.segments.map((segment) => segment.speaker).filter((speaker): speaker is number => speaker !== null))].sort(
    (left, right) => left - right,
  );
  for (const speaker of sources) {
    const given = source.speakerNames[String(speaker)];
    const name = typeof given === "string" ? given.trim() : "";
    const same = name === "" ? undefined : byName.get(name.normalize("NFKC"));
    if (same !== undefined) {
      // 同じ名前の話者が既にいる: その人の続き
      numbers.set(speaker, same);
      continue;
    }
    next += 1;
    numbers.set(speaker, next);
    if (name === "") continue;
    const resolved = names.check(name, next);
    // 規則に合わない名前は付けない（番号だけで足す）
    if (resolved === null) continue;
    speakerNames[String(next)] = resolved;
    names.set(next, resolved);
    byName.set(resolved.trim().normalize("NFKC"), next);
  }
  return { numbers, speakerNames };
}

/** 足した結果の形を確かめる（上限は先に見て too_large と分ける）。 */
function problemOf(segments: readonly RecordingSegment[], speakerNames: Record<string, string>, durationSec: number): AppendRejection | null {
  if (segments.length > RECORDING_SEGMENTS_MAX) return "append_too_large";
  if (segments.some((segment) => Array.from(segment.text).length > RECORDING_SEGMENT_TEXT_MAX_CHARS)) return "append_too_large";
  if (recordingTextBytes(segments) > RECORDING_TEXT_MAX_BYTES) return "append_too_large";
  const problem = recordingDataProblem({ segments, speakerNames, durationSec });
  if (problem === null) return null;
  return problem === "segments" || problem === "size" ? "append_too_large" : "append_invalid";
}

/** あとの音声・字幕の文字起こしを足す（時刻を前の音声の長さだけずらす）。 */
export function appendTranscript(data: RecordingData, source: AppendSource): RecordingData | { rejected: AppendRejection } {
  if (!source || !Array.isArray(source.segments) || source.segments.length === 0) return { rejected: "append_empty" };
  const offsetSec = appendOffsetSec(data);
  if (!Number.isFinite(offsetSec)) return { rejected: "append_invalid" };
  const { numbers, speakerNames } = mapSpeakers(data, source);
  const added: RecordingSegment[] = [];
  for (const segment of source.segments) {
    if (typeof segment?.text !== "string") return { rejected: "append_invalid" };
    // 足す側の時刻は、その音声の先頭を 0 とした秒（ずらす前に見る。ずらした後では負の時刻が通ってしまう）
    if (segment.start !== null || segment.end !== null) {
      const { start, end } = segment;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        return { rejected: "append_invalid" };
      }
    }
    const speaker = segment.speaker === null ? null : (numbers.get(segment.speaker) ?? null);
    added.push(shift({ start: segment.start, end: segment.end, text: segment.text, speaker }, offsetSec));
  }
  const segments = [...data.segments, ...added];
  const length = Math.max(typeof source.durationSec === "number" && Number.isFinite(source.durationSec) && source.durationSec > 0 ? source.durationSec : 0, transcriptEndSec(source.segments));
  const durationSec = offsetSec + length;
  const problem = problemOf(segments, speakerNames, durationSec);
  if (problem) return { rejected: problem };
  return { segments, speakerNames, durationSec };
}
