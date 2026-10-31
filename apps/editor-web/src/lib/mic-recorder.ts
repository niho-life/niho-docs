/**
 * ブラウザのマイクで録音する（#36 段 3b-1。`MediaRecorder`）。録音は端末のメモリに貯め、止めたら名前つきの File にして返す
 * （取り込みは音声ファイルと同じ流れ: audio-upload-client.ts の uploadAudioFile）。
 *
 * - 形式: `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` → ブラウザの既定 の順に `isTypeSupported` で選ぶ。
 *   ファイル名は `録音 YYYY-MM-DD HH-mm.webm`（mp4 は `.m4a`。server が `.mp4` を受け付けないため）。日時は端末の時刻。
 * - 6 時間（取り込みの上限と同じ）で自動で止める。
 * - 後片付け: 止めた・捨てた・画面を離れた（dispose）ときは、マイクのトラックを必ず止める（ブラウザの録音中の印を消す）。
 *   音量の表示は無いので AudioContext は作らない。
 * - 失敗は MicError（denied=許可されていない・no_device=マイクが無い・unsupported=このブラウザでは録音できない・failed=その他）。
 */
import { baseContentType } from "./audio-formats";

export const MIC_MAX_DURATION_MS = 6 * 60 * 60 * 1000;
/** 選ぶ順の形式。どれも使えなければブラウザの既定（mimeType を渡さない）。 */
export const MIC_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;
/** 塊を受け取る間隔（ms）。止めるまで待たずに貯める。 */
export const MIC_TIMESLICE_MS = 1000;

export type MicErrorKind = "denied" | "no_device" | "unsupported" | "failed";

export class MicError extends Error {
  override readonly name = "MicError";
  constructor(readonly kind: MicErrorKind) {
    super(`microphone: ${kind}`);
  }
}

/** MediaRecorder のうち使う部分（テストで偽物に替える）。 */
export type MediaRecorderLike = {
  readonly state: "inactive" | "recording" | "paused";
  readonly mimeType: string;
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type MediaRecorderCtor = {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorderLike;
  isTypeSupported?: (type: string) => boolean;
};

export type MicEnvironment = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder?: MediaRecorderCtor;
  now?: () => number;
};

/** いまのブラウザの口（無いものは undefined。非対応の判定に使う）。 */
export function browserMicEnvironment(): MicEnvironment {
  if (typeof window === "undefined") return {};
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  return {
    getUserMedia: devices && typeof devices.getUserMedia === "function" ? (constraints) => devices.getUserMedia(constraints) : undefined,
    MediaRecorder: typeof window.MediaRecorder === "function" ? (window.MediaRecorder as unknown as MediaRecorderCtor) : undefined,
  };
}

/** 使う形式。どれも使えない・判定できないなら undefined（ブラウザの既定）。 */
export function pickMimeType(recorder: Pick<MediaRecorderCtor, "isTypeSupported"> | undefined): string | undefined {
  const supported = recorder?.isTypeSupported;
  if (typeof supported !== "function") return undefined;
  return MIC_MIME_CANDIDATES.find((type) => {
    try {
      return supported.call(recorder, type);
    } catch {
      return false;
    }
  });
}

/** 録音の形式に対応する拡張子（取り込める形式だけ）。空はブラウザが言わなかったとき（Chrome・Firefox の既定の webm とみなす）。 */
export function extensionForMime(mimeType: string): "webm" | "m4a" | "ogg" | null {
  const base = baseContentType(mimeType);
  if (base === "" || base === "audio/webm" || base === "video/webm") return "webm";
  if (base === "audio/mp4" || base === "video/mp4" || base === "audio/x-m4a") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `録音 YYYY-MM-DD HH-mm.{拡張子}`（端末の時刻）。取り込めない形式なら null。 */
export function recordingFileName(at: Date, mimeType: string): string | null {
  const extension = extensionForMime(mimeType);
  if (!extension) return null;
  return `録音 ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}.${extension}`;
}

export type MicRecording = { file: File; durationSec: number; mimeType: string };

function micErrorOf(error: unknown): MicError {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new MicError("denied");
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new MicError("no_device");
  if (name === "NotSupportedError" || name === "TypeError") return new MicError("unsupported");
  return new MicError("failed");
}

export type MicRecorderOptions = {
  maxDurationMs?: number;
  /** 6 時間・トラックが切れた（マイクが外れた）などで、自分で止めた。録音は残す。 */
  onAutoStop?: (recording: MicRecording) => void;
  /** 録音中に失敗した（録音は残らない）。 */
  onError?: (error: MicError) => void;
};

type Phase = "idle" | "requesting" | "recording" | "stopping" | "stopped" | "disposed";

/** 1 回の録音（使い回さない）。 */
export class MicRecorder {
  private phase: Phase = "idle";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private startedDate = new Date(0);
  private mimeType = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping: { resolve: (recording: MicRecording) => void; reject: (error: MicError) => void } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly env: MicEnvironment = browserMicEnvironment(),
    private readonly options: MicRecorderOptions = {},
  ) {
    this.now = env.now ?? (() => Date.now());
  }

  get state(): Phase {
    return this.phase;
  }

  /** 録音を始めた時からの経過（ms）。止めたあとは止めた時まで。 */
  elapsedMs(): number {
    if (this.phase === "recording") return Math.max(0, this.now() - this.startedAt);
    if (this.phase === "stopping" || this.phase === "stopped") return Math.max(0, this.stoppedAt - this.startedAt);
    return 0;
  }

  /** マイクの許可を求めて録音を始める。失敗は MicError（トラックは止めてある）。 */
  async start(): Promise<void> {
    if (this.phase !== "idle") throw new MicError("failed");
    const { getUserMedia, MediaRecorder: Recorder } = this.env;
    if (!getUserMedia || !Recorder) throw new MicError("unsupported");
    this.phase = "requesting";
    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: true });
    } catch (error) {
      if (this.phase === "requesting") this.phase = "idle";
      throw micErrorOf(error);
    }
    if (this.phase !== "requesting") {
      // 許可を待つ間に捨てられた（画面を離れた）
      stopTracks(stream);
      throw new MicError("failed");
    }
    this.stream = stream;
    const mimeType = pickMimeType(Recorder);
    let recorder: MediaRecorderLike;
    try {
      recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onstop = () => this.finish();
      recorder.onerror = () => this.fail(new MicError("failed"));
      recorder.start(MIC_TIMESLICE_MS);
    } catch (error) {
      this.cleanup();
      this.phase = "idle";
      throw error instanceof MicError ? error : micErrorOf(error);
    }
    this.recorder = recorder;
    this.mimeType = recorder.mimeType || mimeType || "";
    this.startedAt = this.now();
    this.startedDate = new Date();
    this.phase = "recording";
    for (const track of stream.getTracks()) {
      // マイクが外れた・ほかの操作で止められた: 録音はそこまでで止める
      track.addEventListener?.("ended", () => {
        if (this.phase === "recording") this.requestStop();
      });
    }
    this.timer = setTimeout(() => {
      if (this.phase === "recording") this.requestStop();
    }, this.options.maxDurationMs ?? MIC_MAX_DURATION_MS);
  }

  /** 止めて、録音を File にして返す。 */
  stop(): Promise<MicRecording> {
    if (this.phase !== "recording") return Promise.reject(new MicError("failed"));
    return new Promise<MicRecording>((resolve, reject) => {
      this.stopping = { resolve, reject };
      this.requestStop();
    });
  }

  /** 録音を捨てる（録音中なら止める）。トラックは必ず止める。何度呼んでもよい。 */
  dispose(): void {
    if (this.phase === "disposed") return;
    const wasRecording = this.phase === "recording" || this.phase === "stopping";
    this.phase = "disposed";
    const recorder = this.recorder;
    if (wasRecording && recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // 止められなくても、トラックは下で止める
      }
    }
    this.chunks = [];
    this.stopping?.reject(new MicError("failed"));
    this.stopping = null;
    this.cleanup();
  }

  private requestStop(): void {
    if (this.phase !== "recording") return;
    this.phase = "stopping";
    this.stoppedAt = this.now();
    try {
      this.recorder?.stop();
    } catch {
      this.fail(new MicError("failed"));
    }
  }

  /** recorder の stop（自分で止めた・自動で止まった）。 */
  private finish(): void {
    if (this.phase === "disposed" || this.phase === "stopped") return;
    if (this.phase === "recording") this.stoppedAt = this.now();
    const type = this.mimeType || this.chunks[0]?.type || "";
    const name = recordingFileName(this.startedDate, type);
    const pending = this.stopping;
    this.stopping = null;
    this.cleanup();
    if (!name) {
      this.phase = "stopped";
      const error = new MicError("unsupported");
      if (pending) pending.reject(error);
      else this.options.onError?.(error);
      return;
    }
    this.phase = "stopped";
    const file = new File(this.chunks, name, { type: type || "audio/webm" });
    this.chunks = [];
    const recording: MicRecording = { file, durationSec: Math.max(0, this.stoppedAt - this.startedAt) / 1000, mimeType: type || "audio/webm" };
    if (pending) pending.resolve(recording);
    else this.options.onAutoStop?.(recording);
  }

  private fail(error: MicError): void {
    if (this.phase === "disposed" || this.phase === "stopped") return;
    this.phase = "stopped";
    this.chunks = [];
    const pending = this.stopping;
    this.stopping = null;
    this.cleanup();
    if (pending) pending.reject(error);
    else this.options.onError?.(error);
  }

  private cleanup(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      // onstop は、止める要求のあとに来る最後の塊のために残す（finish は phase を見て 2 度目を無視する）
    }
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 既に止まっている
    }
  }
}
