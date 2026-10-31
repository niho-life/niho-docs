import { formatTranscriptSpeakerKey, type TranscriptSpeakerEntry } from "@niho/docs-core";
import { SHELL_TONES, type ShellSegment, type ShellSpeaker, type ShellTone } from "../shell";

/**
 * Mac の保管庫の `transcript.md`（旧 NIHO docs の文字起こし）を、共有の `ShellRecording` が描ける形にする（#45）。
 * 旧データの取り込みや、端末内の文字起こしの結果を見せるときに使う。
 *
 * 形は docs-core の `transcriptMarkdown` が書くもの: 段落は空行で区切られ、`[hh:mm:ss] 話者N: 本文`。
 * 複数の音声は `## Part N: 名前` の見出しで分かれ、話者の番号は Part ごとの scope になる（`formatTranscriptSpeakerKey`）。
 * 話者の名前は版ごとの記録（`RunRecord.transcriptSpeakerNames`）にあり、`listTranscriptSpeakers` が解決済みのものを渡してくる。
 */

const PART_HEADING = /^## Part (\d+):/u;
const TIMESTAMP = /^\[(\d{2,}:\d{2}:\d{2})\] /u;
const LABEL = /^([^:\n]+): /u;
/** docs-core が付ける番号つき・不明のラベル。これだけは名前の記録が無くても話者のラベルとして外す。 */
const GENERATED_LABEL = /^話者(?:(\d+)|[?？])$/u;

/** 話者の色は、一覧に出てくる順（Part → 番号）で割り当てる。 */
export function speakerTones(speakers: readonly TranscriptSpeakerEntry[]): Map<string, ShellTone> {
  const tones = new Map<string, ShellTone>();
  speakers.forEach((speaker, index) => {
    tones.set(speaker.key, SHELL_TONES[index % SHELL_TONES.length] ?? "a");
  });
  return tones;
}

/** 話者の列（名前を変えるボタン）。`id` は版ごとの記録と同じ key。 */
export function transcriptSpeakers(speakers: readonly TranscriptSpeakerEntry[]): ShellSpeaker[] {
  const tones = speakerTones(speakers);
  return speakers.map((speaker) => ({
    id: speaker.key,
    name: speaker.label,
    tone: tones.get(speaker.key) ?? "a",
    ...(speaker.name === null ? { unnamed: true } : {}),
  }));
}

/** `renameTranscriptSpeakerLabel` が名前の記号に付けた `\` を戻す（`A\_B` → `A_B`）。 */
function decodeLabel(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1");
}

/**
 * 文字起こしの段落。`id` は段落の位置（直したものを書き戻すときに使う）。
 *
 * 先頭の `xxx: ` を話者として外すのは、docs-core が付けた番号つき・不明のラベルか、同じ Part の既知の話者の名前
 * （名前を変えたあとの本文は、番号ではなく名前に書き換わっている）のときだけ。それ以外の `Note: ...` のような
 * 発話の一部は、話者を作らず本文のまま残す。
 */
export function transcriptSegments(markdown: string, speakers: readonly TranscriptSpeakerEntry[]): ShellSegment[] {
  const tones = speakerTones(speakers);
  const segments: ShellSegment[] = [];
  let partIndex: number | null = null;
  markdown.split(/\n{2,}/u).forEach((block, index) => {
    const paragraph = block.trim();
    if (paragraph === "") return;
    const heading = PART_HEADING.exec(paragraph);
    if (heading) {
      // docs-core の話者の key と同じ、Part の番号そのまま（`1:1` が Part 1 の話者1）
      partIndex = Number(heading[1]);
      return;
    }
    const timestamp = TIMESTAMP.exec(paragraph);
    const rest = timestamp ? paragraph.slice(timestamp[0].length) : paragraph;
    const label = LABEL.exec(rest);
    const text = label ? decodeLabel(label[1]!.trim()) : "";
    const generated = GENERATED_LABEL.exec(text);
    const speaker = generated?.[1] !== undefined
      ? speakers.find((entry) => entry.key === formatTranscriptSpeakerKey(partIndex, Number(generated[1])))
      : speakers.find((entry) => entry.partIndex === partIndex && entry.name === text);
    const isSpeakerLabel = label !== null && (generated !== null || speaker !== undefined);
    segments.push({
      id: String(index),
      who: speaker?.label ?? (isSpeakerLabel ? text : ""),
      tone: speaker ? (tones.get(speaker.key) ?? "a") : "e",
      time: timestamp?.[1] ?? "",
      text: isSpeakerLabel ? rest.slice(label[0].length) : rest,
    });
  });
  return segments;
}
