import { describe, expect, it } from "vitest";
import { listTranscriptSpeakers, renameTranscriptSpeakerLabel, transcriptMarkdown } from "@niho/docs-core";
import { transcriptSegments, transcriptSpeakers } from "./transcript-view";

/** Mac の保管庫の transcript.md → 共有の ShellRecording が描く行（#45）。合成データだけを使う。 */

const jsonl = (segments: { start: number; end: number; text: string; speaker?: number | null }[]) =>
  segments.map((segment) => JSON.stringify({ type: "segment", ...segment })).join("\n");

describe("文字起こしの表示", () => {
  it("話者つきの段落を、時刻・話者・本文に分ける", () => {
    const markdown = transcriptMarkdown([
      {
        jsonl: jsonl([
          { start: 0, end: 3, text: "こんにちは", speaker: 1 },
          { start: 3, end: 7, text: "よろしくお願いします", speaker: 2 },
        ]),
        offsetSec: 0,
      },
    ]);
    const speakers = listTranscriptSpeakers(markdown);
    const segments = transcriptSegments(markdown, speakers);
    expect(segments.map((segment) => [segment.time, segment.who, segment.text])).toEqual([
      ["00:00:00", "話者1", "こんにちは"],
      ["00:00:03", "話者2", "よろしくお願いします"],
    ]);
    // 話者ごとに色が変わる
    expect(segments[0]!.tone).not.toBe(segments[1]!.tone);
    expect(transcriptSpeakers(speakers).map((speaker) => [speaker.name, speaker.unnamed])).toEqual([
      ["話者1", true],
      ["話者2", true],
    ]);
  });

  it("名前を付けた話者は、その名前で出る", () => {
    const markdown = transcriptMarkdown([{ jsonl: jsonl([{ start: 12, end: 15, text: "鎌倉の話です", speaker: 1 }]), offsetSec: 0 }]);
    const speakers = listTranscriptSpeakers(markdown, { "1": "Takuya" });
    expect(transcriptSegments(markdown, speakers)[0]!.who).toBe("Takuya");
    expect(transcriptSpeakers(speakers)[0]).toMatchObject({ id: "1", name: "Takuya" });
    expect(transcriptSpeakers(speakers)[0]!.unnamed).toBeUndefined();
  });

  it("複数の音声（Part の見出し）は、見出しを行にせず、話者を Part ごとに分ける", () => {
    const markdown = transcriptMarkdown([
      { jsonl: jsonl([{ start: 0, end: 2, text: "ひとつめ", speaker: 1 }]), offsetSec: 0, name: "前半" },
      { jsonl: jsonl([{ start: 0, end: 2, text: "ふたつめ", speaker: 1 }]), offsetSec: 60, name: "後半" },
    ]);
    expect(markdown).toContain("## Part 1: 前半");
    const speakers = listTranscriptSpeakers(markdown, { "2:1": "Mika" });
    const segments = transcriptSegments(markdown, speakers);
    expect(segments.map((segment) => segment.text)).toEqual(["ひとつめ", "ふたつめ"]);
    // Part ごとの名前が、その Part の段落にだけ付く
    expect(segments.map((segment) => segment.who)).toEqual(["話者1", "Mika"]);
    // Part 1 の話者1 と Part 2 の話者1 は別の人として扱う（key が別）
    expect(speakers.map((speaker) => speaker.key)).toEqual(["1:1", "2:1"]);
    expect(segments[0]!.tone).not.toBe(segments[1]!.tone);
  });

  it("話者の無い段落は、時刻と本文だけになる", () => {
    const markdown = transcriptMarkdown([{ jsonl: jsonl([{ start: 5, end: 9, text: "話者を分けない録音" }]), offsetSec: 0 }]);
    const segments = transcriptSegments(markdown, listTranscriptSpeakers(markdown));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ time: "00:00:05", who: "", text: "話者を分けない録音" });
  });

  it("コロンを含む発話は、話者が無ければ本文のまま残し、話者を作らない", () => {
    const markdown = "[00:00:00] Note: bring lunch";
    const speakers = listTranscriptSpeakers(markdown);
    expect(speakers).toEqual([]);
    expect(transcriptSegments(markdown, speakers)[0]).toMatchObject({ time: "00:00:00", who: "", tone: "e", text: "Note: bring lunch" });
  });

  it("名前を変えたあとの本文（番号が名前に書き換わった）も、同じ話者として色と名前を引く", () => {
    const original = transcriptMarkdown([
      {
        jsonl: jsonl([
          { start: 0, end: 3, text: "こんにちは", speaker: 1 },
          { start: 3, end: 7, text: "よろしく", speaker: 2 },
        ]),
        offsetSec: 0,
      },
    ]);
    const renamed = renameTranscriptSpeakerLabel(original, "話者2", "A_B");
    expect(renamed).toContain("A\\_B:");
    const speakers = listTranscriptSpeakers(renamed, { "2": "A_B" });
    const segments = transcriptSegments(renamed, speakers);
    // 名前は `\_` のエスケープを戻した表示名、色は話者の一覧と同じ
    expect(segments.map((segment) => segment.who)).toEqual(["話者1", "A_B"]);
    expect(segments[1]!.tone).toBe(transcriptSpeakers(speakers)[1]!.tone);
    expect(segments[1]!.text).toBe("よろしく");
  });

  it("名前の一致は同じ Part の中だけ。別の Part の名前と同じ文字でも話者にしない", () => {
    const markdown = [
      "## Part 1: 前半",
      "",
      "[00:00:00] Mika: ひとつめ",
      "",
      "## Part 2: 後半",
      "",
      "[00:00:00] Mika: ふたつめ",
    ].join("\n");
    const speakers = listTranscriptSpeakers(markdown, { "1:1": "Mika" });
    const segments = transcriptSegments(markdown, speakers);
    expect(segments.map((segment) => [segment.who, segment.text])).toEqual([
      ["Mika", "ひとつめ"],
      ["", "Mika: ふたつめ"],
    ]);
  });

  it("文字起こしが無ければ行は出ない", () => {
    expect(transcriptSegments("", [])).toEqual([]);
  });
});
