import { createHash } from "node:crypto";
import { VttParseError, parseVtt, type VttCue } from "@niho/docs-core";
import {
  RECORDING_SEGMENTS_MAX,
  RECORDING_SEGMENT_TEXT_MAX_CHARS,
  RECORDING_SOURCE_NAME_MAX_CHARS,
  isStorableText,
  type PageLang,
  type RecordingSegment,
} from "@niho/editor-store";
import { SpeakerNameIndex } from "./speakers";

/**
 * VTT の取り込み（#36 段 1）: WebVTT の原文を、録音ページに保存する段落（segments）と話者名の表にする。
 * 原文の検査と cue の切り出しは docs-core の parseVtt（NIHO docs と同じ規則）。ここでは cue を段落にするだけ。
 * - 時刻は秒（number）。`<v 話者>` の話者は最初に出た順に 1 から番号を付け、規則に合う名前だけを speakerNames に入れる。
 * - 1 つの cue に別々の話者の `<v>` があれば、話者ごとの段落に分ける（同じ時刻）。`</v>` の後の文字は直前の話者のまま。
 * - タグは外し、文字参照（&amp; など）は文字に戻す。HTML としては扱わない（画面は文字として出す）。
 */

/** 取り込める VTT の大きさ（UTF-8 のバイト数）。docs-core の VTT_MAX_BYTES（10 MiB）より小さく、1 行の jsonb を数 MB に抑える。 */
export const VTT_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
/** 取り込みで付ける engine の名前。 */
export const VTT_IMPORT_ENGINE = "vtt-import";
/** 題名の上限（pages.title の CHECK と同じ）。 */
const TITLE_MAX_CHARS = 500;
/** 受け取るファイル名の上限（パスを含めた文字数。超えたら断る）。 */
export const VTT_IMPORT_NAME_MAX_CHARS = 1024;

export type VttImportFailure = "vtt_empty" | "vtt_too_large" | "vtt_invalid" | "name";

/** VTT から読んだ文字起こし（言語は持たない。録音ページを作るとき・あとから足すときの両方で使う）。 */
export type VttTranscript = {
  title: string;
  segments: RecordingSegment[];
  speakerNames: Record<string, string>;
  durationSec: number;
  sourceName: string | null;
  sourceSha256: string;
};

export type VttImport = VttTranscript & { language: PageLang };

export type VttReadResult = { ok: true; value: VttTranscript } | { ok: false; reason: VttImportFailure };
export type VttImportResult = { ok: true; value: VttImport } | { ok: false; reason: VttImportFailure };

/** 名前・題名に残さない文字（制御文字・向きを変える書式文字）。 */
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

function codePoints(text: string): string[] {
  return Array.from(text);
}

/** パス（`/` と `\`）を除いたファイル名。危ない文字を除き、前後の空白を取る。 */
function baseName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? "";
  return last.replace(UNSAFE_NAME_CHARACTERS, "").trim();
}

/** 題名はファイル名から拡張子を除いたもの（`.vtt` など最後の 1 つ。先頭の `.` だけの名前はそのまま）。500 文字まで。 */
function titleFromName(base: string): string {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot).trim() : base;
  return codePoints(stem).slice(0, TITLE_MAX_CHARS).join("");
}

/** `hh:mm:ss.ttt` か `mm:ss.ttt`（parseVtt が形を確かめた後）を秒にする。ミリ秒の整数で足してから割る。 */
export function vttTimestampSeconds(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) throw new VttParseError("invalid", "VTTの時刻が正しくありません。");
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const milliseconds = ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(milliseconds)) throw new VttParseError("invalid", "VTTの時刻が正しくありません。");
  return milliseconds / 1000;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&lrm;": "\u200e",
  "&rlm;": "\u200f",
  "&nbsp;": "\u00a0",
};

/** docs-core の parseVtt が Markdown にするときと同じ文字参照だけを戻す（1 回だけ。`&amp;lt;` は `&lt;` になる）。 */
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|lrm|rlm|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * タグ（`<…>`）を前から 1 回の走査で見つける（`/<([^>]*)>/g` と同じ範囲。最初の `>` までが 1 つのタグ）。
 * 正規表現だと、`>` で閉じない `<` が大量にある cue（80,000 文字で約 5.5 秒）で、各 `<` から末尾まで走査し直して二次時間になる。
 * ここでは、`>` が見つからなければ、それ以降に閉じるタグは無いのでそこで終える。
 */
function* tagsOf(text: string): Generator<{ index: number; length: number; inner: string }> {
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) return;
    const close = text.indexOf(">", open + 1);
    if (close === -1) return;
    yield { index: open, length: close - open + 1, inner: text.slice(open + 1, close) };
    from = close + 1;
  }
}
/** voice の開始タグは docs-core の parseVtt と同じ形（`<v 名前>`・`<v.class 名前>`）。 */
const VOICE = /^v(?:\.[^\s>]*)?(?:[ \t]+([^>]*))?$/i;

type Run = { voice: string | null; text: string };

/** cue の本文を話者ごとの文字に分ける（タグを外し、文字参照を戻す）。空の部分は捨てる。 */
export function splitCueByVoice(text: string): Run[] {
  const runs: Run[] = [{ voice: null, text: "" }];
  let last = 0;
  for (const tag of tagsOf(text)) {
    const current = runs[runs.length - 1]!;
    current.text += text.slice(last, tag.index);
    last = tag.index + tag.length;
    const voice = VOICE.exec(tag.inner);
    if (!voice) continue;
    const name = decodeEntities(voice[1] ?? "").trim() || null;
    if (name === current.voice) continue;
    if (current.text.trim() === "") current.voice = name;
    else runs.push({ voice: name, text: "" });
  }
  runs[runs.length - 1]!.text += text.slice(last);
  return runs
    .map((run) => ({ voice: run.voice, text: decodeEntities(run.text).trim() }))
    .filter((run) => run.text !== "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * VTT の原文を録音の段落にする。ファイル名（name）はパスを除いて題名と sourceName に使う。時刻はその字幕の先頭を 0 とした秒
 * （録音ページに足すときは、呼び出し側が前の音声の長さだけずらす。append-transcript.ts）。
 * 失敗の理由: vtt_empty（空・発言なし）・vtt_too_large（4 MiB を超える・段落が多すぎる・長すぎる段落）・vtt_invalid（形が違う）・name。
 */
export function readVtt(input: { name: string; vtt: string }): VttReadResult {
  if (typeof input.name !== "string" || codePoints(input.name).length > VTT_IMPORT_NAME_MAX_CHARS || !isStorableText(input.name)) {
    return { ok: false, reason: "name" };
  }
  if (typeof input.vtt !== "string") return { ok: false, reason: "vtt_invalid" };
  if (Buffer.byteLength(input.vtt, "utf8") > VTT_IMPORT_MAX_BYTES) return { ok: false, reason: "vtt_too_large" };
  if (!isStorableText(input.vtt)) return { ok: false, reason: "vtt_invalid" };

  let cues: VttCue[];
  try {
    cues = parseVtt(input.vtt).cues;
  } catch (error) {
    if (error instanceof VttParseError) {
      return { ok: false, reason: error.code === "empty" ? "vtt_empty" : error.code === "too_large" ? "vtt_too_large" : "vtt_invalid" };
    }
    throw error;
  }

  const segments: RecordingSegment[] = [];
  const voices = new Map<string, number>();
  let durationSec = 0;
  try {
    for (const cue of cues) {
      const start = vttTimestampSeconds(cue.start);
      const end = vttTimestampSeconds(cue.end);
      durationSec = Math.max(durationSec, end);
      for (const run of splitCueByVoice(cue.text)) {
        let speaker: number | null = null;
        if (run.voice !== null) {
          speaker = voices.get(run.voice) ?? voices.size + 1;
          voices.set(run.voice, speaker);
        }
        if (codePoints(run.text).length > RECORDING_SEGMENT_TEXT_MAX_CHARS) return { ok: false, reason: "vtt_too_large" };
        segments.push({ start, end, text: run.text, speaker });
        if (segments.length > RECORDING_SEGMENTS_MAX) return { ok: false, reason: "vtt_too_large" };
      }
    }
  } catch (error) {
    if (error instanceof VttParseError) return { ok: false, reason: "vtt_invalid" };
    throw error;
  }
  if (segments.length === 0) return { ok: false, reason: "vtt_empty" };

  // 名前は最初に出た順に検査する（docs-core の規則。同じ名前に見えるものが先にあれば、後のものは番号だけ）
  const speakerNames: Record<string, string> = {};
  const names = new SpeakerNameIndex([...voices.values()].map((speaker) => ({ speaker, name: null })));
  for (const [voice, speaker] of voices) {
    const name = names.check(voice, speaker);
    if (name === null) continue;
    speakerNames[String(speaker)] = name;
    names.set(speaker, name);
  }

  const base = baseName(input.name);
  const sourceName = codePoints(base).slice(0, RECORDING_SOURCE_NAME_MAX_CHARS).join("").trim();
  return {
    ok: true,
    value: {
      title: titleFromName(base),
      segments,
      speakerNames,
      durationSec,
      sourceName: sourceName === "" ? null : sourceName,
      sourceSha256: sha256(input.vtt),
    },
  };
}

/** VTT を読んで、録音ページを作るための形にする（言語はページの言語）。 */
export function importVtt(input: { name: string; vtt: string; lang: PageLang }): VttImportResult {
  const read = readVtt(input);
  return read.ok ? { ok: true, value: { ...read.value, language: input.lang } } : read;
}
