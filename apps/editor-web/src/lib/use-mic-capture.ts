"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicError, MicRecorder, browserMicEnvironment, type MicEnvironment, type MicErrorKind, type MicKeepSink, type MicRecording } from "./mic-recorder";
import { recordingKeep, type RecordingKeep } from "./recording-keep";

/**
 * 「録音から」のマイク録音の状態（#36 段 3b-1）。MicRecorder を 1 回の録音ごとに作り、経過時間を 1 秒ごとに更新する。
 * 画面を離れたら（unmount）録音を捨て、マイクのトラックを止める。
 * 録っている間は端末の控え（recording-keep.ts）にも書く（**画面を閉じても録ったものを失わない**）。控えを消すのは、
 * 「消す」を押したとき（discard）と、取り込めたとき（呼び出し側が録音の keepId で消す）だけ。画面を離れただけでは消さない。
 */
export type MicCapture =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "recording"; elapsedMs: number }
  | { status: "stopping" }
  | { status: "ready"; recording: MicRecording }
  | { status: "error"; kind: MicErrorKind };

export function micErrorMessage(kind: MicErrorKind): string {
  switch (kind) {
    case "denied":
      return "マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。";
    case "no_device":
      return "マイクが見つかりません。マイクをつないでから、もう一度試してください。";
    case "unsupported":
      return "このブラウザでは録音できません。音声ファイルを選んでください。";
    default:
      return "マイクを使えませんでした。もう一度試してください。";
  }
}

export type UseMicCaptureOptions = {
  /** 止めた（自分で・6 時間・マイクが外れた）ときに、録音を渡す。 */
  onRecorded?: (recording: MicRecording) => void;
  /** テスト用。 */
  environment?: () => MicEnvironment;
  /** 端末の控え（既定はこの画面の IndexedDB。null は控えなし）。 */
  keep?: RecordingKeep | null;
};

/** 控えへの書き込みの口（待たない・失敗は飲む。録音を止めない）。 */
function micKeepSink(keep: RecordingKeep | null): MicKeepSink | undefined {
  if (!keep) return undefined;
  // 控えられなくても録音は続ける（画面には出さない。値も出さない）。容量を超えた端末では毎秒失敗するので、知らせるのは 1 度だけ
  let told = false;
  const swallow = (error: unknown) => {
    if (told) return;
    told = true;
    console.warn("editor-web: recording keep failed", { name: error instanceof Error ? error.name : "unknown" });
  };
  return {
    begin: (take) => void keep.begin(take).catch(swallow),
    chunk: (id, seq, data, durationSec) => {
      void data
        .arrayBuffer()
        .then((bytes) => keep.addChunk(id, seq, bytes, durationSec))
        .catch(swallow);
    },
    finish: (id, durationSec) => void keep.finish(id, durationSec).catch(swallow),
  };
}

export function useMicCapture(options: UseMicCaptureOptions = {}) {
  const [capture, setCapture] = useState<MicCapture>({ status: "idle" });
  const recorderRef = useRef<MicRecorder | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  // 控えは画面ごとに 1 つ（options.keep が undefined なら、この画面の IndexedDB）
  const keepRef = useRef<RecordingKeep | null | undefined>(undefined);
  const keepOf = useCallback((): RecordingKeep | null => {
    if (keepRef.current === undefined) keepRef.current = optionsRef.current.keep === undefined ? recordingKeep() : optionsRef.current.keep;
    return keepRef.current;
  }, []);

  const deliver = useCallback((recorder: MicRecorder, recording: MicRecording) => {
    if (recorderRef.current !== recorder) return;
    setCapture({ status: "ready", recording });
    optionsRef.current.onRecorded?.(recording);
  }, []);

  const start = useCallback(async (): Promise<MicErrorKind | null> => {
    const current = recorderRef.current;
    if (current && current.state !== "stopped") return null;
    const environment = optionsRef.current.environment?.() ?? browserMicEnvironment();
    const sink = micKeepSink(keepOf());
    const recorder: MicRecorder = new MicRecorder(environment, {
      ...(sink ? { keep: sink } : {}),
      onAutoStop: (recording) => deliver(recorder, recording),
      onError: (error) => {
        if (recorderRef.current === recorder) setCapture({ status: "error", kind: error.kind });
      },
    });
    recorderRef.current = recorder;
    setCapture({ status: "requesting" });
    try {
      await recorder.start();
    } catch (error) {
      if (recorderRef.current !== recorder) return null;
      recorderRef.current = null;
      const kind = error instanceof MicError ? error.kind : "failed";
      setCapture({ status: "error", kind });
      return kind;
    }
    if (recorderRef.current !== recorder) return null;
    setCapture({ status: "recording", elapsedMs: 0 });
    return null;
  }, [deliver, keepOf]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    setCapture({ status: "stopping" });
    try {
      deliver(recorder, await recorder.stop());
    } catch (error) {
      if (recorderRef.current === recorder) setCapture({ status: "error", kind: error instanceof MicError ? error.kind : "failed" });
    }
  }, [deliver]);

  /** いまの録音（録音中・止めたもの）を捨てて、はじめの状態に戻す。端末の控えも消す。 */
  const discard = useCallback(() => {
    const keepId = recorderRef.current?.keepId ?? null;
    recorderRef.current?.dispose();
    recorderRef.current = null;
    if (keepId !== null) void keepOf()?.remove(keepId).catch(() => undefined);
    setCapture({ status: "idle" });
  }, [keepOf]);

  // 経過時間（録音中だけ、1 秒ごと）
  const recording = capture.status === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") setCapture({ status: "recording", elapsedMs: recorder.elapsedMs() });
    }, 1000);
    return () => clearInterval(timer);
  }, [recording]);

  // 画面を離れたら捨てる（トラックを止める）
  useEffect(
    () => () => {
      recorderRef.current?.dispose();
      recorderRef.current = null;
    },
    [],
  );

  return { capture, start, stop, discard };
}
