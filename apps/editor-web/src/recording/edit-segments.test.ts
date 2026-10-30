import { describe, expect, it } from "vitest";
import { RECORDING_SEGMENT_TEXT_MAX_CHARS, RECORDING_TEXT_MAX_BYTES, recordingTextBytes, type RecordingData } from "@niho/editor-store";
import { SEGMENT_EDITS_MAX, editSegments } from "./edit-segments";

// 合成の文字起こしだけを使う

function sample(): RecordingData {
  return {
    segments: [
      { start: 0, end: 1.5, text: "最初の段落", speaker: 1 },
      { start: 1.5, end: 3, text: "二つ目の段落", speaker: 2 },
      { start: null, end: null, text: "時刻の無い段落", speaker: null },
    ],
    speakerNames: { "1": "司会役" },
  };
}

function data(result: RecordingData | { rejected: string }): RecordingData {
  if ("rejected" in result) throw new Error(`expected data, got ${result.rejected}`);
  return result;
}

describe("editSegments", () => {
  it("replaces only the text of the named paragraphs and keeps times and speakers", () => {
    const before = sample();
    const after = data(editSegments(before, [{ index: 1, text: "直した段落" }, { index: 2, text: "" }]));
    expect(after.segments).toEqual([
      { start: 0, end: 1.5, text: "最初の段落", speaker: 1 },
      { start: 1.5, end: 3, text: "直した段落", speaker: 2 },
      { start: null, end: null, text: "", speaker: null },
    ]);
    expect(after.speakerNames).toEqual(before.speakerNames);
    expect(before.segments[1]?.text).toBe("二つ目の段落");
    expect(after.segments[0]).toBe(before.segments[0]);
  });

  it("turns CRLF and CR into LF", () => {
    expect(data(editSegments(sample(), [{ index: 0, text: "一行目\r\n二行目\r三行目\n四行目" }])).segments[0]?.text).toBe("一行目\n二行目\n三行目\n四行目");
  });

  it("refuses indexes outside the paragraphs, repeated indexes, and an empty or too long list", () => {
    for (const index of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(editSegments(sample(), [{ index, text: "x" }]), String(index)).toEqual({ rejected: "index" });
    }
    expect(editSegments(sample(), [{ index: "0" as unknown as number, text: "x" }])).toEqual({ rejected: "index" });
    expect(editSegments(sample(), [{ index: 0, text: "x" }, { index: 0, text: "y" }])).toEqual({ rejected: "index" });
    expect(editSegments(sample(), [])).toEqual({ rejected: "index" });
    const many: RecordingData = { segments: Array.from({ length: SEGMENT_EDITS_MAX + 1 }, () => ({ start: 0, end: 1, text: "x", speaker: null })), speakerNames: {} };
    const edits = (count: number) => Array.from({ length: count }, (_, index) => ({ index, text: `段落 ${index}` }));
    expect(data(editSegments(many, edits(SEGMENT_EDITS_MAX))).segments[SEGMENT_EDITS_MAX - 1]?.text).toBe(`段落 ${SEGMENT_EDITS_MAX - 1}`);
    expect(editSegments(many, edits(SEGMENT_EDITS_MAX + 1))).toEqual({ rejected: "index" });
  });

  it("refuses text that is too long, has NUL or an unpaired surrogate, or is not a string", () => {
    expect(data(editSegments(sample(), [{ index: 0, text: "あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS) }])).segments[0]?.text).toHaveLength(RECORDING_SEGMENT_TEXT_MAX_CHARS);
    for (const text of ["あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS + 1), "a\u0000b", "a\udc00b", 1 as unknown as string, null as unknown as string]) {
      expect(editSegments(sample(), [{ index: 0, text }])).toEqual({ rejected: "text" });
    }
    // 直した後の本文の合計が 8 MiB を超えるなら断る（1 段落ずつは上限の内側でも）
    const large: RecordingData = { segments: Array.from({ length: 690 }, () => ({ start: 0, end: 1, text: "あ".repeat(4000), speaker: null })), speakerNames: {} };
    expect(recordingTextBytes(large.segments)).toBeLessThan(RECORDING_TEXT_MAX_BYTES);
    const grow = (count: number) => Array.from({ length: count }, (_, index) => ({ index, text: "あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS) }));
    expect(recordingTextBytes(data(editSegments(large, grow(30))).segments)).toBeLessThanOrEqual(RECORDING_TEXT_MAX_BYTES);
    expect(editSegments(large, grow(100))).toEqual({ rejected: "text" });
    // 先の edit が通っていても、後の edit が断られたら何も変えない（元の data はそのまま）
    const before = sample();
    expect(editSegments(before, [{ index: 0, text: "通る" }, { index: 1, text: "a\u0000" }])).toEqual({ rejected: "text" });
    expect(before.segments[0]?.text).toBe("最初の段落");
  });
});
