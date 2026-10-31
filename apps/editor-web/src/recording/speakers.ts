import { formatTranscriptSpeakerDefaultLabel, resolveTranscriptSpeakerName, type TranscriptSpeakerEntry } from "@niho/docs-core";
import { isStorableText, type RecordingData } from "@niho/editor-store";

/**
 * 録音の話者（#36 段 1）: 名前を変える・まとめる・一覧。どれも RecordingData を受けて新しい RecordingData を返す純粋な関数で、
 * editor-store の updateRecording の mutate にそのまま渡せる（断るときは `{ rejected: 理由 }`）。
 * 名前は speakerNames の表に 1 つだけ持つ（段落は番号だけを持ち、表示が番号から名前を引く）ので、名前を変えると全段落に反映される。
 * 名前の規則は docs-core の resolveTranscriptSpeakerName（60 文字まで・改行とコロンなし・「話者N」の形は不可・NFKC で同じに見える
 * 名前の衝突は不可）。それに加えて、保存の形（docs-core の speech-result の speakerNames と同じ）に合わせて制御文字を断る。
 */

export type SpeakerSummary = { speaker: number; name: string | null; count: number };
export type SpeakerRejection = "speaker" | "name" | "merge";

/** 名前に入れない制御文字（docs-core の speech-result の speakerNames と同じ範囲）。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function isSpeakerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function entryOf(speaker: number, name: string | null): TranscriptSpeakerEntry {
  return { partIndex: null, index: speaker, key: String(speaker), name, label: name ?? formatTranscriptSpeakerDefaultLabel(speaker) };
}

/**
 * 話者の今の表示名（名前か「話者N」）を NFKC で引ける索引。docs-core の規則は「同じに見える表示名が他の話者にあるか」なので、
 * 同じ NFKC の表示名を持つ話者だけを候補として渡す（話者が多くても 1 回の検査が全員を見ない）。
 */
export class SpeakerNameIndex {
  readonly #byLabel = new Map<string, Map<number, TranscriptSpeakerEntry>>();
  readonly #entries = new Map<number, TranscriptSpeakerEntry>();

  constructor(speakers: Iterable<{ speaker: number; name: string | null }> = []) {
    for (const { speaker, name } of speakers) this.set(speaker, name);
  }

  /** 話者の名前を入れ替える（null は名前を外し、表示は「話者N」）。 */
  set(speaker: number, name: string | null): void {
    const previous = this.#entries.get(speaker);
    if (previous) this.#byLabel.get(previous.label.normalize("NFKC"))?.delete(speaker);
    const entry = entryOf(speaker, name);
    this.#entries.set(speaker, entry);
    const label = entry.label.normalize("NFKC");
    const group = this.#byLabel.get(label) ?? new Map<number, TranscriptSpeakerEntry>();
    group.set(speaker, entry);
    this.#byLabel.set(label, group);
  }

  /** この話者に付けられる名前（前後の空白を除いたもの）か、規則に合わなければ null。 */
  check(name: string, speaker: number): string | null {
    if (typeof name !== "string" || CONTROL_CHARACTERS.test(name) || !isStorableText(name)) return null;
    const candidates = [...(this.#byLabel.get(name.trim().normalize("NFKC"))?.values() ?? [])];
    return resolveTranscriptSpeakerName({ name, speaker: entryOf(speaker, null), speakers: candidates });
  }
}

/** 話者の一覧（番号の順）。段落に出てくる話者と、名前の表にある話者の和。count はその話者の段落の数。 */
export function listSpeakers(data: RecordingData): SpeakerSummary[] {
  const counts = new Map<number, number>();
  for (const segment of data.segments) {
    if (segment.speaker !== null) counts.set(segment.speaker, (counts.get(segment.speaker) ?? 0) + 1);
  }
  for (const key of Object.keys(data.speakerNames)) {
    const speaker = Number(key);
    if (isSpeakerNumber(speaker) && String(speaker) === key && !counts.has(speaker)) counts.set(speaker, 0);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([speaker, count]) => ({ speaker, name: data.speakerNames[String(speaker)] ?? null, count }));
}

function hasSegments(data: RecordingData, speaker: number): boolean {
  return data.segments.some((segment) => segment.speaker === speaker);
}

/**
 * 話者の名前を変える（null は名前を外す）。段落に出てこない話者は "speaker"、規則に合わない・他の話者と同じに見える名前は "name"。
 * 段落は変えない（表示は番号から名前を引くので、全段落に反映される）。
 */
export function renameSpeaker(data: RecordingData, speaker: number, name: string | null): RecordingData | { rejected: SpeakerRejection } {
  if (!isSpeakerNumber(speaker) || !hasSegments(data, speaker)) return { rejected: "speaker" };
  const key = String(speaker);
  const speakerNames = { ...data.speakerNames };
  if (name === null) {
    delete speakerNames[key];
    return { segments: data.segments, speakerNames };
  }
  if (typeof name !== "string") return { rejected: "name" };
  const resolved = new SpeakerNameIndex(listSpeakers(data)).check(name, speaker);
  if (resolved === null) return { rejected: "name" };
  speakerNames[key] = resolved;
  return { segments: data.segments, speakerNames };
}

/**
 * 話者 from を into にまとめる: from の段落を into に付け替え、名前の表から from を除く。into に名前が無く from に有れば、
 * into がその名前を引き継ぐ（両方に有れば into の名前のまま）。from と into が同じなら "merge"、どちらかが段落に無ければ "speaker"。
 */
export function mergeSpeakers(data: RecordingData, from: number, into: number): RecordingData | { rejected: SpeakerRejection } {
  if (!isSpeakerNumber(from) || !isSpeakerNumber(into)) return { rejected: "speaker" };
  if (from === into) return { rejected: "merge" };
  if (!hasSegments(data, from) || !hasSegments(data, into)) return { rejected: "speaker" };
  const fromKey = String(from);
  const intoKey = String(into);
  const speakerNames = { ...data.speakerNames };
  const inherited = speakerNames[fromKey];
  if (speakerNames[intoKey] === undefined && inherited !== undefined) speakerNames[intoKey] = inherited;
  delete speakerNames[fromKey];
  return {
    segments: data.segments.map((segment) => (segment.speaker === from ? { ...segment, speaker: into } : segment)),
    speakerNames,
  };
}
