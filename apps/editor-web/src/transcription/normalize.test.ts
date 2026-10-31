import { describe, expect, it } from "vitest";
import { RECORDING_SEGMENTS_MAX, RECORDING_SEGMENT_TEXT_MAX_CHARS, recordingDataProblem, type RecordingSegment } from "@niho/editor-store";
import { EngineError } from "./engine";
import { normalizeEngineResult, splitLongText } from "./normalize";

// 合成の段落だけを使う

const seg = (text: string, speaker: number | null, start: number | null, end: number | null): RecordingSegment => ({ start, end, text, speaker });

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    return (error as EngineError).code;
  }
}

describe("normalizeEngineResult", () => {
  it("numbers the speakers from 1 in order of first appearance, after sorting by time", () => {
    const result = normalizeEngineResult(
      {
        segments: [seg("三つ目", 0, 6, 9), seg("一つ目", 3, 0, 3), seg("二つ目", 0, 3, 6), seg("四つ目", 7, 9, 12)],
        durationSec: 12,
      },
      { diarize: true },
    );
    expect(result.segments).toEqual([seg("一つ目", 1, 0, 3), seg("二つ目", 2, 3, 6), seg("三つ目", 2, 6, 9), seg("四つ目", 3, 9, 12)]);
    expect(result.durationSec).toBe(12);
    expect(recordingDataProblem({ segments: result.segments, speakerNames: {} })).toBeNull();
  });

  it("turns Deepgram's zero-based speakers into 1, 2 and keeps segments without a speaker as null", () => {
    const result = normalizeEngineResult({ segments: [seg("a", 0, 0, 1), seg("b", 1, 1, 2), seg("c", null, 2, 3), seg("d", 0, 3, 4)], durationSec: null }, { diarize: true });
    expect(result.segments.map((segment) => segment.speaker)).toEqual([1, 2, null, 1]);
    expect(result.durationSec).toBeNull();
  });

  it("drops every speaker when diarization is off, and ignores speaker numbers that are not integers", () => {
    expect(normalizeEngineResult({ segments: [seg("a", 0, 0, 1), seg("b", 1, 1, 2)], durationSec: 2 }, { diarize: false }).segments.map((s) => s.speaker)).toEqual([null, null]);
    expect(
      normalizeEngineResult({ segments: [seg("a", -1, 0, 1), seg("b", 1.5, 1, 2), seg("c", Number.NaN, 2, 3)], durationSec: 2 }, { diarize: true }).segments.map((s) => s.speaker),
    ).toEqual([null, null, null]);
  });

  it("cleans the text: trims, turns line breaks into spaces, removes control characters and NUL, and drops empty segments", () => {
    const result = normalizeEngineResult(
      {
        segments: [seg("  前後の空白  ", 0, 0, 1), seg("改行\nと\tタブ", 0, 1, 2), seg("制\u0000御\u0007文字\u007f", 0, 2, 3), seg("   ", 1, 3, 4), seg("\u0000", 1, 4, 5), seg("壊れた\ud800文字", 0, 5, 6)],
        durationSec: 6,
      },
      { diarize: true },
    );
    expect(result.segments.map((segment) => segment.text)).toEqual(["前後の空白", "改行 と タブ", "制御文字", "壊れた文字"]);
    // 空の段落の話者（生の 1）は番号を取らない
    expect(result.segments.map((segment) => segment.speaker)).toEqual([1, 1, 1, 1]);
  });

  it("keeps only finite non-negative times, aligns an end before the start, and puts segments without a time last in their order", () => {
    const result = normalizeEngineResult(
      { segments: [seg("時刻なし1", 0, null, null), seg("後ろ", 0, 5, 4), seg("負", 0, -1, 2), seg("先", 0, 1, 2), seg("終わりなし", 0, 3, Number.NaN)], durationSec: -3 },
      { diarize: true },
    );
    expect(result.segments).toEqual([seg("先", 1, 1, 2), seg("終わりなし", 1, 3, 3), seg("後ろ", 1, 5, 5), seg("時刻なし1", 1, null, null), seg("負", 1, null, null)]);
    expect(result.durationSec).toBeNull();
  });

  it("splits a paragraph longer than 5,000 characters, sharing its time by length", () => {
    const sentence = "あ".repeat(2999) + "。";
    const result = normalizeEngineResult({ segments: [seg(sentence + sentence, 0, 10, 20)], durationSec: 20 }, { diarize: true });
    expect(result.segments).toHaveLength(2);
    expect(result.segments.map((segment) => segment.text)).toEqual([sentence, sentence]);
    expect(result.segments.map((segment) => [segment.start, segment.end, segment.speaker])).toEqual([
      [10, 15, 1],
      [15, 20, 1],
    ]);
  });

  it("rejects results over the segment count or the total size as too_large", () => {
    const many = Array.from({ length: RECORDING_SEGMENTS_MAX + 1 }, (_, index) => seg(`段落${index}`, 0, index, index + 1));
    expect(codeOf(() => normalizeEngineResult({ segments: many, durationSec: null }, { diarize: true }))).toBe("too_large");
    // 1 段落 4,000 文字（3 バイト）× 800 = 9.6 MB > 8 MiB
    const big = Array.from({ length: 800 }, (_, index) => seg("文".repeat(4000), 0, index, index + 1));
    expect(codeOf(() => normalizeEngineResult({ segments: big, durationSec: null }, { diarize: true }))).toBe("too_large");
    // 割ると上限を超える
    const splitting = Array.from({ length: RECORDING_SEGMENTS_MAX }, (_, index) => seg(index === 0 ? "a ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS) : "b", 0, index, index + 1));
    expect(codeOf(() => normalizeEngineResult({ segments: splitting, durationSec: null }, { diarize: true }))).toBe("too_large");
    expect(codeOf(() => normalizeEngineResult({ segments: "nope" as never, durationSec: null }, { diarize: true }))).toBe("bad_response");
  });
});

describe("splitLongText", () => {
  it("splits after a sentence end first, then at a space, then by length", () => {
    expect(splitLongText("ab。cd。ef", 5)).toEqual(["ab。", "cd。ef"]);
    expect(splitLongText("Hello world. Again!", 13)).toEqual(["Hello world.", "Again!"]);
    expect(splitLongText("abc def ghi", 5)).toEqual(["abc", "def", "ghi"]);
    expect(splitLongText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(splitLongText("あいう！えお？かき", 4)).toEqual(["あいう！", "えお？", "かき"]);
    expect(splitLongText("short", 5)).toEqual(["short"]);
    // サロゲートペア（絵文字）を途中で割らない
    expect(splitLongText("😀😀😀😀😀", 2)).toEqual(["😀😀", "😀😀", "😀"]);
    for (const piece of splitLongText("。".repeat(12_000))) expect(Array.from(piece).length).toBeLessThanOrEqual(RECORDING_SEGMENT_TEXT_MAX_CHARS);
  });
});
