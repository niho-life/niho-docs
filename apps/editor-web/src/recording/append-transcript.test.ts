import { RECORDING_SEGMENTS_MAX, RECORDING_SEGMENT_TEXT_MAX_CHARS, recordingDataProblem, type RecordingData, type RecordingSegment } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { appendOffsetSec, appendTranscript, transcriptEndSec, type AppendSource } from "./append-transcript";

/** 1 本目（10 分の音声。最後の段落は 9:58 で終わる）。 */
function first(): RecordingData {
  return {
    segments: [
      { start: 0, end: 4, text: "はじめます", speaker: 1 },
      { start: 4, end: 598, text: "よろしくお願いします", speaker: 2 },
    ],
    speakerNames: { "1": "Takuya", "2": "ゲスト" },
    durationSec: 600,
  };
}

/** 2 本目（5 分の音声。その音声の先頭を 0 とした時刻）。 */
function second(): AppendSource {
  return {
    segments: [
      { start: 0, end: 3, text: "続きです", speaker: 1 },
      { start: 3, end: 298, text: "そうですね", speaker: 2 },
    ],
    speakerNames: { "1": "Takuya", "2": "ほかの人" },
    durationSec: 300,
  };
}

function data(result: RecordingData | { rejected: string }): RecordingData {
  if ("rejected" in result) throw new Error(`rejected: ${result.rejected}`);
  return result;
}

const times = (value: RecordingData) => value.segments.map((segment) => [segment.start, segment.end]);
const segment = (text: string, speaker: number | null = null): RecordingSegment => ({ start: 0, end: 1, text, speaker });

describe("appendTranscript（複数音声）", () => {
  it("2 本目の時刻を、前の音声の長さだけずらして足す", () => {
    const merged = data(appendTranscript(first(), second()));
    expect(times(merged)).toEqual([
      [0, 4],
      [4, 598],
      // 600（1 本目の音声の長さ）だけ後ろへ
      [600, 603],
      [603, 898],
    ]);
    expect(merged.segments.map((item) => item.text)).toEqual(["はじめます", "よろしくお願いします", "続きです", "そうですね"]);
    // 録音の長さは 600 + 300（次に足すときのずらす量になる）
    expect(merged.durationSec).toBe(900);
    expect(recordingDataProblem(merged)).toBeNull();
  });

  it("3 本目は、1 本目と 2 本目の長さの合計だけずらす", () => {
    const merged = data(appendTranscript(data(appendTranscript(first(), second())), { segments: [{ start: 0, end: 10, text: "三本目", speaker: null }], speakerNames: {}, durationSec: 60 }));
    expect(times(merged).at(-1)).toEqual([900, 910]);
    expect(merged.durationSec).toBe(960);
  });

  it("音声の長さが分からないときは、段落の末尾を長さとみなす", () => {
    const base: RecordingData = { segments: [{ start: 0, end: 30, text: "前", speaker: null }], speakerNames: {}, durationSec: null };
    const merged = data(appendTranscript(base, { segments: [{ start: 0, end: 5, text: "後", speaker: null }], speakerNames: {}, durationSec: null }));
    expect(times(merged)).toEqual([
      [0, 30],
      [30, 35],
    ]);
    expect(merged.durationSec).toBe(35);
  });

  it("字幕が音声より長いときは、字幕の末尾だけずらす（重ねない）", () => {
    const base: RecordingData = { segments: [{ start: 0, end: 700, text: "長い字幕", speaker: null }], speakerNames: {}, durationSec: 600 };
    expect(appendOffsetSec(base)).toBe(700);
    const merged = data(appendTranscript(base, { segments: [{ start: 0, end: 5, text: "後", speaker: null }], speakerNames: {}, durationSec: 60 }));
    expect(times(merged).at(-1)).toEqual([700, 705]);
    expect(merged.durationSec).toBe(760);
  });

  it("時刻を持たない段落は、時刻なしのまま足す", () => {
    const merged = data(appendTranscript(first(), { segments: [{ start: null, end: null, text: "時刻なし", speaker: null }], speakerNames: {}, durationSec: 60 }));
    expect(times(merged).at(-1)).toEqual([null, null]);
  });

  it("話者は今ある番号の後ろに続け、同じ名前の人には寄せる", () => {
    const merged = data(appendTranscript(first(), second()));
    // Takuya は 1 本目と同じ話者 1、「ほかの人」は新しい話者 3
    expect(merged.segments.map((item) => item.speaker)).toEqual([1, 2, 1, 3]);
    expect(merged.speakerNames).toEqual({ "1": "Takuya", "2": "ゲスト", "3": "ほかの人" });
  });

  it("名前の無い話者は、寄せずに新しい番号になる", () => {
    const merged = data(appendTranscript(first(), { segments: [segment("名前なし", 1)], speakerNames: {}, durationSec: 60 }));
    expect(merged.segments.at(-1)?.speaker).toBe(3);
    expect(merged.speakerNames).toEqual({ "1": "Takuya", "2": "ゲスト" });
  });

  it("規則に合わない名前は付けず、段落は番号だけで足す", () => {
    const merged = data(appendTranscript(first(), { segments: [segment("名前が変", 1)], speakerNames: { "1": "話者1" }, durationSec: 60 }));
    expect(merged.segments.at(-1)?.speaker).toBe(3);
    expect(merged.speakerNames["3"]).toBeUndefined();
    expect(recordingDataProblem(merged)).toBeNull();
  });

  it("足す段落が無ければ断る（何も変えない）", () => {
    expect(appendTranscript(first(), { segments: [], speakerNames: {}, durationSec: 60 })).toEqual({ rejected: "append_empty" });
  });

  it("段落の数・1 段落の文字数の上限を超えたら断る", () => {
    const base: RecordingData = { segments: Array.from({ length: RECORDING_SEGMENTS_MAX - 1 }, () => segment("あ")), speakerNames: {}, durationSec: 1 };
    expect(appendTranscript(base, { segments: [segment("い")], speakerNames: {}, durationSec: 1 })).not.toHaveProperty("rejected");
    expect(appendTranscript(base, { segments: [segment("い"), segment("う")], speakerNames: {}, durationSec: 1 })).toEqual({ rejected: "append_too_large" });
    expect(appendTranscript(first(), { segments: [segment("あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS + 1))], speakerNames: {}, durationSec: 1 })).toEqual({
      rejected: "append_too_large",
    });
  });

  it("足す側の時刻・文字の形が規則に合わなければ断る", () => {
    expect(appendTranscript(first(), { segments: [{ start: 5, end: 1, text: "逆さ", speaker: null }], speakerNames: {}, durationSec: 1 })).toEqual({ rejected: "append_invalid" });
    expect(appendTranscript(first(), { segments: [{ start: -1, end: 1, text: "負", speaker: null }], speakerNames: {}, durationSec: 1 })).toEqual({ rejected: "append_invalid" });
    expect(appendTranscript(first(), { segments: [segment("NUL\u0000")], speakerNames: {}, durationSec: 1 })).toEqual({ rejected: "append_invalid" });
  });

  it("transcriptEndSec は時刻の無い段落を数えない", () => {
    expect(transcriptEndSec([{ start: null, end: null, text: "x", speaker: null }])).toBe(0);
    expect(transcriptEndSec([{ start: 0, end: 3, text: "x", speaker: null }, { start: null, end: null, text: "y", speaker: null }])).toBe(3);
  });
});
