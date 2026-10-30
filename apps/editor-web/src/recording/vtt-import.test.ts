import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RECORDING_SEGMENTS_MAX, RECORDING_SEGMENT_TEXT_MAX_CHARS } from "@niho/editor-store";
import { VTT_IMPORT_MAX_BYTES, importVtt, splitCueByVoice, vttTimestampSeconds, type VttImport } from "./vtt-import";

// 合成の VTT だけを使う（実在の人の名前・会話・ファイルを使わない）

const vtt = (...lines: string[]) => lines.join("\n");

function ok(result: ReturnType<typeof importVtt>): VttImport {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

const run = (source: string, name = "合成の会議.vtt") => importVtt({ name, vtt: source, lang: "ja" });

describe("importVtt", () => {
  it("numbers <v> speakers in order of first appearance and keeps their names in one table", () => {
    const value = ok(
      run(
        vtt(
          "WEBVTT",
          "",
          "cue-1",
          "00:00:01.250 --> 00:00:03.900 align:start",
          "<v 司会役>おはようございます</v>",
          "",
          "00:04.000 --> 00:05.500",
          "<v.loud 記録役>はい &amp; どうぞ</v>",
          "",
          "00:00:06.000 --> 00:00:07.000",
          "<v 司会役>はじめましょう",
          "",
        ),
      ),
    );
    expect(value.segments).toEqual([
      { start: 1.25, end: 3.9, text: "おはようございます", speaker: 1 },
      { start: 4, end: 5.5, text: "はい & どうぞ", speaker: 2 },
      { start: 6, end: 7, text: "はじめましょう", speaker: 1 },
    ]);
    expect(value.speakerNames).toEqual({ "1": "司会役", "2": "記録役" });
    expect(value.durationSec).toBe(7);
    expect(value.language).toBe("ja");
  });

  it("leaves the speaker empty when there are no <v> tags", () => {
    const value = ok(run(vtt("WEBVTT", "", "00:00.000 --> 00:02.000", "話者の無い発言", "", "00:02.000 --> 00:03.000", "次の発言")));
    expect(value.segments).toEqual([
      { start: 0, end: 2, text: "話者の無い発言", speaker: null },
      { start: 2, end: 3, text: "次の発言", speaker: null },
    ]);
    expect(value.speakerNames).toEqual({});
  });

  it("keeps multi-line cues as one paragraph, strips other tags, and keeps text after </v> with the same speaker", () => {
    const value = ok(run(vtt("WEBVTT", "", "00:01.000 --> 00:02.000", "<v Alpha>一行目</v>", "二行目 <b>強調</b> <00:00:01.500>続き", "&lt;b&gt;は文字")));
    expect(value.segments).toEqual([{ start: 1, end: 2, text: "一行目\n二行目 強調 続き\n<b>は文字", speaker: 1 }]);
    expect(value.speakerNames).toEqual({ "1": "Alpha" });
  });

  it("splits a cue with two different speakers into one paragraph each, at the same time", () => {
    const value = ok(run(vtt("WEBVTT", "", "00:01.000 --> 00:03.000", "<v Alpha>質問です</v>", "<v Beta>答えます</v>", "<v Beta>続けて")));
    expect(value.segments).toEqual([
      { start: 1, end: 3, text: "質問です", speaker: 1 },
      { start: 1, end: 3, text: "答えます\n続けて", speaker: 2 },
    ]);
    expect(splitCueByVoice("(拍手) <v Alpha>はい")).toEqual([
      { voice: null, text: "(拍手)" },
      { voice: "Alpha", text: "はい" },
    ]);
    expect(splitCueByVoice("<v Alpha></v><v Beta>はい")).toEqual([{ voice: "Beta", text: "はい" }]);
  });

  it("reads BOM and CRLF the same as LF, but hashes the original text", () => {
    const lines = ["WEBVTT", "", "00:00.000 --> 00:01.000", "<v Alpha>一行目", "二行目", ""];
    const lf = ok(run(lines.join("\n")));
    const crlf = ok(run(`\uFEFF${lines.join("\r\n")}`));
    expect(crlf.segments).toEqual(lf.segments);
    expect(crlf.segments[0]?.text).toBe("一行目\n二行目");
    expect(crlf.sourceSha256).not.toBe(lf.sourceSha256);
    expect(crlf.sourceSha256).toBe(createHash("sha256").update(Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8")).digest("hex"));
    expect(lf.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("converts times to seconds and takes the duration from the latest end", () => {
    expect(vttTimestampSeconds("01:02:03.456")).toBe(3723.456);
    expect(vttTimestampSeconds("00:00.001")).toBe(0.001);
    expect(vttTimestampSeconds("100:00:00.000")).toBe(360000);
    expect(() => vttTimestampSeconds("1:2.3")).toThrow();
    const value = ok(run(vtt("WEBVTT", "", "00:10.000 --> 01:00:20.500", "長い", "", "00:30.000 --> 00:40.000", "後の cue だが早く終わる")));
    expect(value.segments.map((segment) => [segment.start, segment.end])).toEqual([[10, 3620.5], [30, 40]]);
    expect(value.durationSec).toBe(3620.5);
  });

  it("refuses empty, malformed, NUL, and tag-only files with a short reason", () => {
    expect(run("")).toEqual({ ok: false, reason: "vtt_empty" });
    expect(run("   \n")).toEqual({ ok: false, reason: "vtt_empty" });
    expect(run(vtt("WEBVTT", "", "NOTE 書き手向け", "表示しない", ""))).toEqual({ ok: false, reason: "vtt_empty" });
    expect(run(vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "<b></b>", ""))).toEqual({ ok: false, reason: "vtt_empty" });
    expect(run("合成のただの文字")).toEqual({ ok: false, reason: "vtt_invalid" });
    expect(run(vtt("WEBVTT", "", "00:05.000 --> 00:04.000", "逆転", ""))).toEqual({ ok: false, reason: "vtt_invalid" });
    expect(run(vtt("WEBVTT", "", "not a cue", "本文", ""))).toEqual({ ok: false, reason: "vtt_invalid" });
    expect(run(vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "a\u0000b", ""))).toEqual({ ok: false, reason: "vtt_invalid" });
    expect(run(vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "a\ud800b", ""))).toEqual({ ok: false, reason: "vtt_invalid" });
  });

  it("accepts up to 4 MiB of UTF-8 and refuses one byte more", () => {
    const head = vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "上限の確認", "", "NOTE ");
    const pad = VTT_IMPORT_MAX_BYTES - Buffer.byteLength(head, "utf8") - 1;
    const exact = `${head}${"x".repeat(pad)}\n`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(VTT_IMPORT_MAX_BYTES);
    expect(ok(run(exact)).segments).toEqual([{ start: 0, end: 1, text: "上限の確認", speaker: null }]);
    expect(run(`${exact}x`)).toEqual({ ok: false, reason: "vtt_too_large" });
    // 文字数ではなく UTF-8 のバイト数で数える（「あ」は 3 バイト）
    const japanese = `${head}${"あ".repeat(Math.ceil(pad / 3) + 1)}\n`;
    expect(japanese.length).toBeLessThan(VTT_IMPORT_MAX_BYTES);
    expect(run(japanese)).toEqual({ ok: false, reason: "vtt_too_large" });
  });

  it("refuses more paragraphs than the store keeps, and paragraphs longer than the store keeps", () => {
    const cues = (count: number) => ["WEBVTT", ...Array.from({ length: count }, (_, index) => `\n00:00.000 --> 00:01.000\n${index}`)].join("\n");
    expect(ok(run(cues(RECORDING_SEGMENTS_MAX))).segments).toHaveLength(RECORDING_SEGMENTS_MAX);
    expect(run(cues(RECORDING_SEGMENTS_MAX + 1))).toEqual({ ok: false, reason: "vtt_too_large" });
    const long = (count: number) => vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "あ".repeat(count), "");
    expect(ok(run(long(RECORDING_SEGMENT_TEXT_MAX_CHARS))).segments[0]?.text).toHaveLength(RECORDING_SEGMENT_TEXT_MAX_CHARS);
    expect(run(long(RECORDING_SEGMENT_TEXT_MAX_CHARS + 1))).toEqual({ ok: false, reason: "vtt_too_large" });
  });

  it("keeps only names that follow the docs-core rules, and gives every voice its own number", () => {
    const value = ok(
      run(
        vtt(
          "WEBVTT",
          "",
          "00:00.000 --> 00:01.000",
          "<v 話者3>既定の形の名前",
          "",
          "00:01.000 --> 00:02.000",
          "<v 時刻: 10時>コロンを含む名前",
          "",
          "00:02.000 --> 00:03.000",
          `<v ${"長".repeat(61)}>長すぎる名前`,
          "",
          "00:03.000 --> 00:04.000",
          "<v ＡＢ>全角の名前",
          "",
          "00:04.000 --> 00:05.000",
          "<v AB>NFKC で同じに見える名前",
          "",
          "00:05.000 --> 00:06.000",
          "<v>名前の無い voice",
          "",
          "00:06.000 --> 00:07.000",
          `<v ${"短".repeat(60)}>60 文字の名前`,
          "",
          "00:07.000 --> 00:08.000",
          "<v\tTab\tName>タブで区切った名前",
          "",
        ),
      ),
    );
    expect(value.segments.map((segment) => segment.speaker)).toEqual([1, 2, 3, 4, 5, null, 6, 7]);
    expect(value.speakerNames).toEqual({ "4": "ＡＢ", "6": "短".repeat(60) });
  });

  it("takes the title and source name from the file name without the path", () => {
    const source = vtt("WEBVTT", "", "00:00.000 --> 00:01.000", "本文", "");
    const named = (name: string) => ok(importVtt({ name, vtt: source, lang: "en" }));
    expect(named("C:\\fakepath\\合成の会議.vtt")).toMatchObject({ title: "合成の会議", sourceName: "合成の会議.vtt", language: "en" });
    expect(named("dir/sub/notes.final.vtt")).toMatchObject({ title: "notes.final", sourceName: "notes.final.vtt" });
    expect(named("no-extension")).toMatchObject({ title: "no-extension", sourceName: "no-extension" });
    expect(named("")).toMatchObject({ title: "", sourceName: null });
    expect(named("dir/")).toMatchObject({ title: "", sourceName: null });
    expect(named("\u202e会議\u0007.vtt")).toMatchObject({ title: "会議", sourceName: "会議.vtt" });
    const long = named(`${"名".repeat(600)}.vtt`);
    expect(Array.from(long.title)).toHaveLength(500);
    expect(Array.from(long.sourceName ?? "")).toHaveLength(200);
    expect(importVtt({ name: "a\u0000.vtt", vtt: source, lang: "ja" })).toEqual({ ok: false, reason: "name" });
    expect(importVtt({ name: "n".repeat(1025), vtt: source, lang: "ja" })).toEqual({ ok: false, reason: "name" });
  });
});
