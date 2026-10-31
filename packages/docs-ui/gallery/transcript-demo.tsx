import { useState } from "react";
import { SHELL_TONES, ShellRecording, type ShellSegment } from "../src/shell";
import { TRANSCRIPT } from "./data";

/** `#/page:rec?…` で強制する文字起こしの状態。 */
export type TranscriptForced = {
  /** 話者の数（2〜6。既定は 2）。 */
  speakers?: number;
  /** 直している状態から始める。 */
  edit?: boolean;
  /** 時刻を出すか（既定は出す）。 */
  time?: boolean;
  /** 再生できるか（既定は再生できる。false は音声の無い録音）。 */
  play?: boolean;
};

type Person = { id: string; name: string | null; label: string };

// 名前が null の話者は「話者N」と呼ぶ（名前がまだ無い録音の取り込み直後）。長い名前は折り返しの確認用
const PEOPLE: Person[] = [
  { id: "1", name: "Takuya", label: "話者1" },
  { id: "2", name: "Mika", label: "話者2" },
  { id: "3", name: "Haruka Yamamoto-Nakagawa（NIHO kamakura ホスト）", label: "話者3" },
  { id: "4", name: "Ken", label: "話者4" },
  { id: "5", name: null, label: "話者5" },
  { id: "6", name: null, label: "話者6" },
];

const EXTRA: { speaker: string; time: string; text: string }[] = [
  { speaker: "3", time: "01:48", text: "うちの近所でも同じような集まりがあって、最初は三人だけでした。" },
  { speaker: "4", time: "02:05", text: "人数が増えたときの席の決め方は、どうしているんですか。" },
  { speaker: "5", time: "02:31", text: "来た順に座ってもらいます。" },
  { speaker: "6", time: "02:40", text: "名前はまだ付けていません。" },
];

const SPEAKER_OF: Record<string, string> = { s1: "1", s2: "2", s3: "1", s4: "1" };

const failure = (name: string): string | undefined => (/^話者\s*[0-9０-９]+$/u.test(name) ? "「話者1」のような形の名前は使えません。" : undefined);

/** ギャラリー用の文字起こし。直した文章・名前・まとめた話者を、このページの state だけで持つ。 */
export function TranscriptDemo({ forced }: { forced: TranscriptForced }) {
  const count = Math.min(6, Math.max(2, forced.speakers ?? 2));
  const [editing, setEditing] = useState(forced.edit ?? false);
  const [timestamps, setTimestamps] = useState(forced.time ?? true);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string | null>>(() => Object.fromEntries(PEOPLE.map((person) => [person.id, person.name])));
  const [merged, setMerged] = useState<Record<string, string>>({});

  const rows = [
    ...TRANSCRIPT.map((segment) => ({ ...segment, speaker: SPEAKER_OF[segment.id] ?? "1" })),
    ...EXTRA.filter((item) => Number(item.speaker) <= count).map((item, index) => ({ id: `x${index}`, who: "", tone: "a" as const, current: false, ...item })),
  ];
  const speakerOf = (speaker: string): string => {
    let id = speaker;
    for (let step = 0; step < PEOPLE.length && merged[id]; step += 1) id = merged[id]!;
    return id;
  };
  const nameOf = (id: string): string => names[id] ?? PEOPLE.find((person) => person.id === id)?.label ?? id;
  const toneOf = (id: string) => SHELL_TONES[(Number(id) - 1) % SHELL_TONES.length] ?? "a";
  const segments: ShellSegment[] = rows.map((row) => {
    const speaker = speakerOf(row.speaker);
    return { id: row.id, who: nameOf(speaker), tone: toneOf(speaker), time: row.time, text: texts[row.id] ?? row.text, current: row.current };
  });
  const present = [...new Set(rows.map((row) => speakerOf(row.speaker)))].sort();

  return (
    <ShellRecording
      segments={segments}
      speakers={present.map((id) => ({ id, name: nameOf(id), tone: toneOf(id), unnamed: names[id] === null }))}
      position={forced.play === false ? "長さ 14:38" : "05:12 / 14:38"}
      editing={editing}
      onToggleEdit={() => setEditing((value) => !value)}
      onPlay={forced.play === false ? undefined : () => undefined}
      onSegmentChange={(id, text) => setTexts((current) => ({ ...current, [id]: text }))}
      onRenameSpeaker={(id, name) => {
        if (name !== null && failure(name)) return failure(name);
        setNames((current) => ({ ...current, [id]: name }));
      }}
      onMergeSpeakers={(from, into) => setMerged((current) => ({ ...current, [from]: into }))}
      showTimestamps={timestamps}
      onTimestamps={() => setTimestamps((value) => !value)}
    />
  );
}
