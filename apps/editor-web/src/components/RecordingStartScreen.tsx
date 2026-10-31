"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { RecordingStart, type RecordingHow, type RecordingNext } from "niho-docs-ui/shell";
import { RecordingRequestError, VTT_FILE_MAX_BYTES, importVtt, recordingErrorMessage } from "@/lib/recording-client";
import { useEditorFrame } from "./EditorFrame";

type Message = { kind: "info" | "error"; text: string };

const AUDIO_NAME = /\.(m4a|mp3|wav)$/i;
const VTT_NAME = /\.vtt$/i;

const AUDIO_UNAVAILABLE: Message = {
  kind: "info",
  text: "音声ファイルの文字起こしは、まだ使えません。いまは、文字起こし済みの .vtt ファイルを取り込めます。",
};
const MIC_UNAVAILABLE: Message = {
  kind: "info",
  text: "マイクでの録音は、まだ使えません。いまは、文字起こし済みの .vtt ファイルを取り込めます。",
};

function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 選んだファイルを調べる。取り込める .vtt なら null、だめなら理由。 */
function rejectionOf(file: File): Message | null {
  if (VTT_NAME.test(file.name) || file.type === "text/vtt") {
    return file.size > VTT_FILE_MAX_BYTES ? { kind: "error", text: "ファイルが大きすぎます。.vtt は 4 MiB までです。" } : null;
  }
  if (AUDIO_NAME.test(file.name) || file.type.startsWith("audio/")) return AUDIO_UNAVAILABLE;
  return { kind: "error", text: "このファイルは取り込めません。文字起こし済みの .vtt ファイルを選んでください。" };
}

/**
 * `/p/new?from=recording`。いまは、文字起こし済みの .vtt を取り込んで録音ページを作る（#36 段 1 の API）。
 * 音声ファイルとマイクは「まだ使えません」と知らせるだけ（後段）。背景情報・登場人物・「このあと」は、手順（#37）ができるまで使われない。
 */
export function RecordingStartScreen() {
  const router = useRouter();
  const frame = useEditorFrame();
  const [background, setBackground] = useState("");
  const [next, setNext] = useState<RecordingNext>("article");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // 取り込み中の二重送信を、再描画を待たずに止める
  const importing = useRef(false);

  const choose = (picked: File | undefined) => {
    if (!picked) return;
    const problem = rejectionOf(picked);
    setMessage(problem);
    if (!problem) setFile(picked);
  };

  const start = async () => {
    if (importing.current) return;
    if (!file) {
      setMessage({ kind: "error", text: "取り込む .vtt ファイルを選んでください。" });
      return;
    }
    const problem = rejectionOf(file);
    if (problem) {
      setMessage(problem);
      return;
    }
    importing.current = true;
    setBusy(true);
    setMessage({ kind: "info", text: "取り込んでいます" });
    try {
      const vtt = await file.text().catch(() => null);
      if (vtt === null) throw new Error("unreadable");
      const imported = await importVtt({ name: file.name, vtt });
      frame.pageCreated(imported.page.id, imported.page.title);
      router.push(`/p/${imported.page.id}`);
      // 移るまで、もう一度取り込ませない（この画面は移ると外れる）
    } catch (error) {
      // 選んだファイルは残す。もう一度押せる
      setMessage({ kind: "error", text: error instanceof RecordingRequestError ? recordingErrorMessage(error, "import") : "ファイルを読み込めませんでした。選び直してください。" });
      importing.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div
        onDragOver={(event: DragEvent) => event.preventDefault()}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          choose(event.dataTransfer.files[0]);
        }}
      >
        <RecordingStart
          how="file"
          onHow={(how: RecordingHow) => {
            if (how === "mic") setMessage(MIC_UNAVAILABLE);
            else input.current?.click();
          }}
          file={file ? { name: file.name, detail: `${sizeLabel(file.size)} · 別のファイルを選ぶ` } : undefined}
          background={background}
          onBackground={setBackground}
          people={[]}
          terms=""
          next={next}
          onNext={setNext}
          onStart={() => void start()}
        />
      </div>
      <input
        ref={input}
        type="file"
        accept=".vtt,text/vtt"
        hidden
        tabIndex={-1}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          // 同じファイルをもう一度選んでも change が起きるように
          event.target.value = "";
        }}
      />
      <div className="es-start" aria-busy={busy}>
        <p role="status" aria-live="polite">
          {message?.kind === "info" ? message.text : ""}
        </p>
        {message?.kind === "error" && <p role="alert">{message.text}</p>}
      </div>
    </>
  );
}
