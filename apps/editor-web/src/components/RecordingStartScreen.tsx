"use client";

import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { RecordingStart, type RecordingHow, type RecordingNext } from "niho-docs-ui/shell";
import { AUDIO_FILE_ACCEPT, AUDIO_FILE_EXTENSIONS_LABEL, isAudioFileName } from "@/lib/audio-formats";
import { probeAudioDuration } from "@/lib/audio-duration";
import { audioUploadMessage, checkAudioFile, getAudioLimitsCached, type AudioLimits } from "@/lib/audio-upload-client";
import type { MicRecording } from "@/lib/mic-recorder";
import { RecordingRequestError, VTT_FILE_MAX_BYTES, importVtt, recordingErrorMessage } from "@/lib/recording-client";
import { formatClock } from "@/lib/recording-view";
import { AUDIO_STAGE_LABELS, useAudioImport } from "@/lib/use-audio-import";
import { micErrorMessage, useMicCapture } from "@/lib/use-mic-capture";
import { useEditorFrame } from "./EditorFrame";

type Message = { kind: "info" | "error"; text: string };

const VTT_NAME = /\.vtt$/i;
const FILE_HINT = `${AUDIO_FILE_EXTENSIONS_LABEL}、文字起こし済みの .vtt も`;
const IMPORT_LABEL = "取り込む";

const PANEL_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 };
const PROGRESS_STYLE: CSSProperties = { flex: "1 1 160px", minWidth: 0, width: "100%" };

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function isVtt(file: File): boolean {
  return VTT_NAME.test(file.name) || file.type === "text/vtt";
}

/** 選んだ .vtt を調べる。取り込めるなら null、だめなら理由。 */
function vttRejection(file: File): Message | null {
  return file.size > VTT_FILE_MAX_BYTES ? { kind: "error", text: "ファイルが大きすぎます。.vtt は 4 MiB までです。" } : null;
}

const UNKNOWN_FILE: Message = { kind: "error", text: "このファイルは取り込めません。音声ファイルか、文字起こし済みの .vtt ファイルを選んでください。" };

/**
 * `/p/new?from=recording`（#36 段 3a・3b-1）。
 * - 文字起こし済みの .vtt は、そのまま録音ページを作る（段 1 の API）。
 * - 音声ファイル（.m4a .mp3 .wav .aac .ogg .flac .webm）は「取り込む」で、上限の確認 → sha256 → 開始 → 保存先へ直接 PUT → 完了。
 *   進み具合（段階と %）が見え、中止できる。終わったら録音ページへ移る（文字起こしは録音ページで始める）。
 * - 「録音する」→「録音をはじめる」でマイクから録音し、「止める」と同じ取り込みの流れに乗る。「やり直す」は確認してから捨てる。
 * - 取り込み中・録音中・まだ取り込んでいない録音があるときは、閉じる前にブラウザの確認を出す。失敗しても選んだファイル・録音は残す。
 * 背景情報・登場人物・「このあと」は、手順（#37）ができるまで使われない。
 */
export function RecordingStartScreen() {
  const router = useRouter();
  const frame = useEditorFrame();
  const [how, setHow] = useState<RecordingHow>("file");
  const [background, setBackground] = useState("");
  const [next, setNext] = useState<RecordingNext>("article");
  const [file, setFile] = useState<File | null>(null);
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const [limits, setLimits] = useState<AudioLimits | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // いま選んでいるファイル（非同期の検査の結果が、選び直したあとのファイルに当たらないため）
  const fileRef = useRef<File | null>(null);
  // 取り込み中の二重送信を、再描画を待たずに止める
  const importing = useRef(false);
  const audio = useAudioImport();

  const importAudio = async (source: File, durationSec: number | null) => {
    if (importing.current) return;
    importing.current = true;
    setBusy(true);
    setMessage(null);
    const outcome = await audio.run(source, { durationSec });
    if (outcome.ok) {
      const { page } = outcome.result;
      setMessage({ kind: "info", text: AUDIO_STAGE_LABELS.completing });
      frame.pageCreated(page.id, page.title, "rec");
      router.push(`/p/${page.id}`);
      // 移るまで、もう一度取り込ませない（この画面は移ると外れる）
      return;
    }
    // 選んだファイル・録音は残す。もう一度押せる
    setMessage({ kind: outcome.kind === "aborted" ? "info" : "error", text: audioUploadMessage(outcome.kind, limits) });
    importing.current = false;
    setBusy(false);
  };

  const mic = useMicCapture({
    // 止めたら（6 時間で自動で止まったときも）そのまま取り込む
    onRecorded: (recording: MicRecording) => void importAudio(recording.file, recording.durationSec),
  });
  const micStatus = mic.capture.status;
  const micBusy = micStatus === "requesting" || micStatus === "recording" || micStatus === "stopping";
  const locked = busy || micBusy;

  const chooseAudio = (picked: File) => {
    fileRef.current = picked;
    setFile(picked);
    setFileDuration(null);
    setMessage(picked.size === 0 ? { kind: "error", text: audioUploadMessage("empty") } : null);
    if (picked.size === 0) {
      fileRef.current = null;
      setFile(null);
      return;
    }
    // 上限（server の値）で調べる。読めなければ「取り込む」のときにもう一度調べる
    void getAudioLimitsCached().then(
      (loaded) => {
        setLimits(loaded);
        if (fileRef.current !== picked) return;
        const check = checkAudioFile({ name: picked.name, size: picked.size, type: picked.type }, loaded);
        if (!check.ok) {
          fileRef.current = null;
          setFile(null);
          setMessage({ kind: "error", text: audioUploadMessage(check.kind, loaded) });
        }
      },
      () => undefined,
    );
    void probeAudioDuration(picked).then((duration) => {
      if (fileRef.current === picked) setFileDuration(duration);
    });
  };

  const choose = (picked: File | undefined) => {
    if (!picked || locked) return;
    setHow("file");
    if (isVtt(picked)) {
      const problem = vttRejection(picked);
      setMessage(problem);
      if (!problem) {
        fileRef.current = picked;
        setFile(picked);
        setFileDuration(null);
      }
      return;
    }
    if (isAudioFileName(picked.name)) {
      chooseAudio(picked);
      return;
    }
    setMessage(UNKNOWN_FILE);
  };

  const importChosenVtt = async (vttFile: File) => {
    importing.current = true;
    setBusy(true);
    setMessage({ kind: "info", text: "取り込んでいます" });
    try {
      const vtt = await vttFile.text().catch(() => null);
      if (vtt === null) throw new Error("unreadable");
      const imported = await importVtt({ name: vttFile.name, vtt });
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

  const startMic = async () => {
    setMessage(null);
    setConfirmDiscard(false);
    const failed = await mic.start();
    if (failed) setMessage({ kind: "error", text: micErrorMessage(failed) });
  };

  const start = async () => {
    if (importing.current) return;
    if (how === "mic") {
      if (micStatus === "idle" || micStatus === "error") await startMic();
      else if (micStatus === "recording") await mic.stop();
      else if (micStatus === "ready") await importAudio(mic.capture.recording.file, mic.capture.recording.durationSec);
      return;
    }
    if (!file) {
      setMessage({ kind: "error", text: "取り込むファイルを選んでください。" });
      return;
    }
    if (isVtt(file)) {
      const problem = vttRejection(file);
      if (problem) {
        setMessage(problem);
        return;
      }
      await importChosenVtt(file);
      return;
    }
    await importAudio(file, fileDuration);
  };

  const discardRecording = () => {
    mic.discard();
    setConfirmDiscard(false);
    setMessage(null);
  };

  // 録音の失敗（録音中に止まった）
  const micError = micStatus === "error" ? micErrorMessage(mic.capture.kind) : null;
  // 取り込み中・録音中・まだ取り込んでいない録音があるまま閉じようとしたら、ブラウザの確認を出す
  const unsaved = busy || micBusy || micStatus === "ready";
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const audioChosen = how === "file" && file !== null && !isVtt(file);
  const startLabel =
    how === "mic"
      ? micStatus === "recording" || micStatus === "stopping"
        ? "止める"
        : micStatus === "ready"
          ? IMPORT_LABEL
          : undefined
      : audioChosen
        ? IMPORT_LABEL
        : undefined;
  const fileDetail = file ? `${fileDuration !== null ? `${formatClock(fileDuration)} · ` : ""}${sizeLabel(file.size)} · 別のファイルを選ぶ` : "";
  const progress = audio.progress;
  const statusText = progress ? AUDIO_STAGE_LABELS[progress.stage] : message?.kind === "info" ? message.text : "";
  const alertText = message?.kind === "error" ? message.text : micError;

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
          how={how}
          onHow={(nextHow: RecordingHow) => {
            if (locked) return;
            setHow(nextHow);
            setConfirmDiscard(false);
            if (nextHow === "file") input.current?.click();
          }}
          file={file ? { name: file.name, detail: fileDetail } : undefined}
          fileHint={FILE_HINT}
          startLabel={startLabel}
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
        accept={`.vtt,text/vtt,${AUDIO_FILE_ACCEPT}`}
        hidden
        tabIndex={-1}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          // 同じファイルをもう一度選んでも change が起きるように
          event.target.value = "";
        }}
      />
      <div className="es-start" aria-busy={busy}>
        {how === "mic" && (micStatus === "recording" || micStatus === "stopping") && (
          <div style={PANEL_STYLE} data-mic="recording">
            <span className="es-note">録音中</span>
            <time role="timer" aria-label="録音の経過時間" dateTime={`PT${Math.floor((mic.capture.status === "recording" ? mic.capture.elapsedMs : 0) / 1000)}S`}>
              {formatClock(mic.capture.status === "recording" ? mic.capture.elapsedMs / 1000 : 0)}
            </time>
            <span className="es-sp" />
            {micStatus === "recording" && !confirmDiscard && (
              <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => setConfirmDiscard(true)}>
                やり直す
              </button>
            )}
          </div>
        )}
        {how === "mic" && micStatus === "ready" && !busy && (
          <div style={PANEL_STYLE} data-mic="ready">
            <span className="es-note">
              {mic.capture.recording.file.name} · {formatClock(mic.capture.recording.durationSec)} · {sizeLabel(mic.capture.recording.file.size)}
            </span>
            <span className="es-sp" />
            {!confirmDiscard && (
              <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => setConfirmDiscard(true)}>
                やり直す
              </button>
            )}
          </div>
        )}
        {how === "mic" && confirmDiscard && (micStatus === "recording" || micStatus === "ready") && !busy && (
          <div style={PANEL_STYLE} role="group" aria-label="録音を消す" data-mic="confirm">
            <span className="es-note">いまの録音を消しますか</span>
            <span className="es-sp" />
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={discardRecording}>
              消す
            </button>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => setConfirmDiscard(false)}>
              やめる
            </button>
          </div>
        )}
        {progress && (
          <div style={PANEL_STYLE} data-audio-import={progress.stage}>
            <progress max={100} value={progress.percent} aria-label="取り込みの進み具合" style={PROGRESS_STYLE} />
            <span className="es-note" aria-hidden="true">
              {progress.percent}%
            </span>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={audio.cancel}>
              中止
            </button>
          </div>
        )}
        <p role="status" aria-live="polite">
          {statusText}
        </p>
        {alertText && <p role="alert">{alertText}</p>}
      </div>
    </>
  );
}
