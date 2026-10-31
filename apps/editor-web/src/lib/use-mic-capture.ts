"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicError, MicRecorder, browserMicEnvironment, type MicEnvironment, type MicErrorKind, type MicRecording } from "./mic-recorder";

/**
 * 「録音から」のマイク録音の状態（#36 段 3b-1）。MicRecorder を 1 回の録音ごとに作り、経過時間を 1 秒ごとに更新する。
 * 画面を離れたら（unmount）録音を捨て、マイクのトラックを止める。
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
};

export function useMicCapture(options: UseMicCaptureOptions = {}) {
  const [capture, setCapture] = useState<MicCapture>({ status: "idle" });
  const recorderRef = useRef<MicRecorder | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const deliver = useCallback((recorder: MicRecorder, recording: MicRecording) => {
    if (recorderRef.current !== recorder) return;
    setCapture({ status: "ready", recording });
    optionsRef.current.onRecorded?.(recording);
  }, []);

  const start = useCallback(async (): Promise<MicErrorKind | null> => {
    const current = recorderRef.current;
    if (current && current.state !== "stopped") return null;
    const environment = optionsRef.current.environment?.() ?? browserMicEnvironment();
    const recorder: MicRecorder = new MicRecorder(environment, {
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
  }, [deliver]);

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

  /** いまの録音（録音中・止めたもの）を捨てて、はじめの状態に戻す。 */
  const discard = useCallback(() => {
    recorderRef.current?.dispose();
    recorderRef.current = null;
    setCapture({ status: "idle" });
  }, []);

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
