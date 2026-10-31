/**
 * 録音ページの再生（#36 段 3b-2）の純粋な関数: 音声の URL・再生できるか・時刻から段落を引く（二分探索）・再生位置の表示。
 * 音声をつなぐのは use-recording-playback.ts、画面は components/RecordingTranscript.tsx と PlaybackSeek.tsx。
 */
import type { RecordingAudio, RecordingSegment } from "@niho/editor-store";
import { formatClock } from "./recording-view";
import { isAudioExpired } from "./transcription-view";

/** 録音の音声を流す同じ origin の route（src/server/audio-stream-api.ts）。 */
export function playbackSrc(pageId: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/recording/audio`;
}

/** 再生できる音声か（アップロード済みで、期限を過ぎていない）。音声の無い録音・アップロード途中・期限切れは false。 */
export function isPlayable(audio: RecordingAudio | null, now: number): boolean {
  return audio !== null && audio.status === "uploaded" && !isAudioExpired(audio, now);
}

/**
 * 時刻から段落を引くための索引。時刻のある段落だけを、始まりの時刻の順（同じ時刻は段落の順）に並べたもの。
 * id は段落の位置の文字列（recording-view.ts の shellSegments と同じ）。
 */
export type SegmentTimeline = { readonly starts: readonly number[]; readonly ids: readonly string[] };

export function segmentTimeline(segments: readonly Pick<RecordingSegment, "start">[]): SegmentTimeline {
  const entries: { start: number; index: number }[] = [];
  segments.forEach((segment, index) => {
    if (segment.start !== null && Number.isFinite(segment.start) && segment.start >= 0) entries.push({ start: segment.start, index });
  });
  // 文字起こしは時刻の順に並んでいるのがふつう。並んでいなければ並べ直す（同じ時刻は段落の順のまま）
  const sorted = entries.every((entry, at) => at === 0 || entries[at - 1]!.start <= entry.start);
  if (!sorted) entries.sort((a, b) => a.start - b.start || a.index - b.index);
  return { starts: entries.map((entry) => entry.start), ids: entries.map((entry) => String(entry.index)) };
}

/** starts の中で、value 以下（inclusive）／未満の最後の位置の次（＝個数）。二分探索。 */
function countBelow(starts: readonly number[], value: number, inclusive: boolean): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const at = starts[middle]!;
    if (inclusive ? at <= value : at < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * いまの再生位置（秒）の段落の id。始まりが位置以下の段落のうち最後のもの（次の段落が始まるまでは、前の段落のまま。終わりの時刻は
 * 見ない＝段落のあいだの無音で強調が消えたり点いたりしない）。同じ時刻に始まる段落が並ぶときは最初の段落。最初の段落より前・
 * 時刻のある段落が無いときは null。二分探索なので段落が 20,000 でも 15 回ほどで引ける。
 */
export function segmentAt(timeline: SegmentTimeline, seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const { starts, ids } = timeline;
  const last = countBelow(starts, seconds, true) - 1;
  if (last < 0) return null;
  // 同じ時刻に始まる段落のうち最初
  const first = countBelow(starts, starts[last]!, false);
  return ids[first] ?? null;
}

/** 段落（id は段落の位置）の始まりの時刻（秒）。時刻の無い段落・知らない id は null。 */
export function segmentStart(segments: readonly Pick<RecordingSegment, "start">[], id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const start = segments[Number(id)]?.start;
  return start !== undefined && start !== null && Number.isFinite(start) && start >= 0 ? start : null;
}

/** 再生位置の表示（`01:23 / 14:38`。長さが分からなければ位置だけ）。 */
export function playbackClock(seconds: number, durationSec: number | null): string {
  const now = formatClock(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
  const total = durationSec !== null ? formatClock(durationSec) : "";
  return total ? `${now} / ${total}` : now;
}

/**
 * 音声の長さ（秒）。ブラウザが読んだ長さ（有限で正）を使い、分からなければ録音の長さ（取り込みの申告）。
 * ブラウザのマイク録音（MediaRecorder の webm）は長さが書かれておらず、ブラウザは Infinity を返すことがある。
 */
export function playbackDuration(mediaDuration: number, recordingSec: number | null): number | null {
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return recordingSec !== null && Number.isFinite(recordingSec) && recordingSec > 0 ? recordingSec : null;
}
