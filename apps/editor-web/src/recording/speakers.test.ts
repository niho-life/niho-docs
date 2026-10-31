import { describe, expect, it } from "vitest";
import { recordingDataProblem, type RecordingData, type RecordingSegment } from "@niho/editor-store";
import { SpeakerNameIndex, listSpeakers, mergeSpeakers, renameSpeaker } from "./speakers";

// 合成の話者名だけを使う（実在の人の名前を使わない）

const segment = (text: string, speaker: number | null, start = 0): RecordingSegment => ({ start, end: start + 1, text, speaker });

function sample(): RecordingData {
  return {
    segments: [segment("一つ目", 1, 0), segment("二つ目", 2, 1), segment("三つ目", 1, 2), segment("拍手", null, 3), segment("四つ目", 3, 4)],
    speakerNames: { "1": "司会役", "3": "記録役" },
  };
}

function data(result: RecordingData | { rejected: string }): RecordingData {
  if ("rejected" in result) throw new Error(`expected data, got ${result.rejected}`);
  expect(recordingDataProblem(result)).toBeNull();
  return result;
}

/** 表示: 段落ごとに番号から名前を引く（名前が無ければ「話者N」）。 */
const labels = (value: RecordingData) => value.segments.map((item) => (item.speaker === null ? null : (value.speakerNames[String(item.speaker)] ?? `話者${item.speaker}`)));

describe("listSpeakers", () => {
  it("lists every speaker in number order with its name and paragraph count", () => {
    expect(listSpeakers(sample())).toEqual([
      { speaker: 1, name: "司会役", count: 2 },
      { speaker: 2, name: null, count: 1 },
      { speaker: 3, name: "記録役", count: 1 },
    ]);
    expect(listSpeakers({ segments: [segment("x", null)], speakerNames: {} })).toEqual([]);
    expect(listSpeakers({ segments: [segment("x", 10), segment("y", 2)], speakerNames: {} }).map((item) => item.speaker)).toEqual([2, 10]);
  });
});

describe("renameSpeaker", () => {
  it("changes the one name in the table, so every paragraph of that speaker shows it", () => {
    const before = sample();
    const after = data(renameSpeaker(before, 1, "  進行役 "));
    expect(after.speakerNames).toEqual({ "1": "進行役", "3": "記録役" });
    expect(after.segments).toBe(before.segments);
    expect(labels(after)).toEqual(["進行役", "話者2", "進行役", null, "記録役"]);
    expect(before.speakerNames["1"]).toBe("司会役");

    const named = data(renameSpeaker(before, 2, "発言役"));
    expect(labels(named)).toEqual(["司会役", "発言役", "司会役", null, "記録役"]);
    expect(data(renameSpeaker(before, 1, "司会役")).speakerNames["1"]).toBe("司会役");
  });

  it("removes the name with null", () => {
    const after = data(renameSpeaker(sample(), 1, null));
    expect(after.speakerNames).toEqual({ "3": "記録役" });
    expect(labels(after)[0]).toBe("話者1");
    expect(data(renameSpeaker(sample(), 2, null)).speakerNames).toEqual({ "1": "司会役", "3": "記録役" });
  });

  it("refuses names against the docs-core rules and names that look the same as another speaker's", () => {
    for (const name of ["記録役", "記録役 ", "話者2", "話者", "時刻: 10時", "時刻：10時", "改行\nあり", "タブ\tあり", "", "   ", "長".repeat(61), "a\u0000b"]) {
      expect(renameSpeaker(sample(), 1, name), JSON.stringify(name)).toEqual({ rejected: "name" });
    }
    const wide = data(renameSpeaker(sample(), 2, "ＡＢ"));
    expect(renameSpeaker(wide, 1, "AB")).toEqual({ rejected: "name" });
    expect(data(renameSpeaker(sample(), 1, "長".repeat(60))).speakerNames["1"]).toHaveLength(60);
    expect(renameSpeaker(sample(), 1, 1 as unknown as string)).toEqual({ rejected: "name" });
  });

  it("refuses a speaker that no paragraph has", () => {
    for (const speaker of [4, 0, -1, 1.5, Number.NaN]) expect(renameSpeaker(sample(), speaker, "名前")).toEqual({ rejected: "speaker" });
  });
});

describe("mergeSpeakers", () => {
  it("moves the paragraphs of one speaker to another and drops the merged name", () => {
    const before = sample();
    const after = data(mergeSpeakers(before, 3, 1));
    expect(after.segments.map((item) => item.speaker)).toEqual([1, 2, 1, null, 1]);
    expect(after.speakerNames).toEqual({ "1": "司会役" });
    expect(listSpeakers(after)).toEqual([
      { speaker: 1, name: "司会役", count: 3 },
      { speaker: 2, name: null, count: 1 },
    ]);
    expect(before.segments.map((item) => item.speaker)).toEqual([1, 2, 1, null, 3]);
    expect(after.segments.map((item) => item.text)).toEqual(before.segments.map((item) => item.text));
  });

  it("lets the remaining speaker take over the name when it has none", () => {
    const after = data(mergeSpeakers(sample(), 3, 2));
    expect(after.speakerNames).toEqual({ "1": "司会役", "2": "記録役" });
    expect(labels(after)).toEqual(["司会役", "記録役", "司会役", null, "記録役"]);
    expect(data(mergeSpeakers(sample(), 2, 1)).speakerNames).toEqual({ "1": "司会役", "3": "記録役" });
  });

  it("refuses merging a speaker into itself and speakers that no paragraph has", () => {
    expect(mergeSpeakers(sample(), 1, 1)).toEqual({ rejected: "merge" });
    expect(mergeSpeakers(sample(), 4, 1)).toEqual({ rejected: "speaker" });
    expect(mergeSpeakers(sample(), 1, 4)).toEqual({ rejected: "speaker" });
    expect(mergeSpeakers(sample(), 0, 1)).toEqual({ rejected: "speaker" });
    expect(mergeSpeakers(sample(), 1, 2.5)).toEqual({ rejected: "speaker" });
  });
});

describe("SpeakerNameIndex", () => {
  it("checks a name only against speakers whose shown name looks the same", () => {
    const index = new SpeakerNameIndex([
      { speaker: 1, name: null },
      { speaker: 2, name: "ＡＢ" },
    ]);
    expect(index.check("AB", 1)).toBeNull();
    expect(index.check("AB", 2)).toBe("AB");
    // 名前の無い話者の表示は「話者N」なので、全角の数字で同じに見える名前も断る
    expect(index.check("話者１", 2)).toBeNull();
    index.set(2, null);
    expect(index.check("AB", 1)).toBe("AB");
  });
});
