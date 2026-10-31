import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIC_MAX_DURATION_MS,
  MicError,
  MicRecorder,
  browserMicEnvironment,
  extensionForMime,
  pickMimeType,
  recordingFileName,
  type MediaRecorderCtor,
  type MediaRecorderLike,
  type MicEnvironment,
} from "./mic-recorder";

/** マイクのトラックの偽物。 */
class FakeTrack {
  stopped = false;
  private listeners: (() => void)[] = [];
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, listener: () => void) {
    if (type === "ended") this.listeners.push(listener);
  }
  end() {
    for (const listener of this.listeners) listener();
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

/** MediaRecorder の偽物。start で塊の受け取りを始め、stop で最後の塊と stop を出す。 */
function fakeRecorderClass(supported: string[] = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"], defaultType = "audio/webm;codecs=opus") {
  const instances: FakeRecorder[] = [];
  class FakeRecorder implements MediaRecorderLike {
    static isTypeSupported = vi.fn((type: string) => supported.includes(type));
    state: "inactive" | "recording" | "paused" = "inactive";
    readonly mimeType: string;
    timeslice: number | undefined;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(
      readonly stream: MediaStream,
      readonly options?: { mimeType?: string },
    ) {
      this.mimeType = options?.mimeType ?? defaultType;
      instances.push(this);
    }
    start(timeslice?: number) {
      this.timeslice = timeslice;
      this.state = "recording";
    }
    emit(bytes: number[]) {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      this.emit([9]);
      this.onstop?.();
    }
  }
  return { Recorder: FakeRecorder as unknown as MediaRecorderCtor & { isTypeSupported: ReturnType<typeof vi.fn> }, instances };
}

function environment(overrides: Partial<MicEnvironment> = {}) {
  const streams: FakeStream[] = [];
  const { Recorder, instances } = fakeRecorderClass();
  const env: MicEnvironment = {
    getUserMedia: vi.fn(async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream as unknown as MediaStream;
    }),
    MediaRecorder: Recorder,
    ...overrides,
  };
  return { env, streams, instances: instances as unknown as { emit: (bytes: number[]) => void; timeslice?: number; options?: { mimeType?: string }; onerror: ((event: unknown) => void) | null; state: string }[] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2030, 0, 2, 9, 5, 30));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("mic recorder helpers", () => {
  it("picks opus webm first, then webm, then mp4, else the browser's default", () => {
    const only = (supported: string[]) => ({ isTypeSupported: (type: string) => supported.includes(type) });
    expect(pickMimeType(only(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType(only(["audio/webm", "audio/mp4"]))).toBe("audio/webm");
    expect(pickMimeType(only(["audio/mp4"]))).toBe("audio/mp4");
    expect(pickMimeType(only([]))).toBeUndefined();
    expect(pickMimeType({})).toBeUndefined();
    expect(pickMimeType({ isTypeSupported: () => {
      throw new Error("x");
    } })).toBeUndefined();
  });

  it("names the file after the local date and time, with an extension the server accepts", () => {
    const at = new Date(2030, 0, 2, 9, 5);
    expect(recordingFileName(at, "audio/webm;codecs=opus")).toBe("録音 2030-01-02 09-05.webm");
    expect(recordingFileName(at, "audio/mp4")).toBe("録音 2030-01-02 09-05.m4a");
    expect(recordingFileName(at, "audio/ogg;codecs=opus")).toBe("録音 2030-01-02 09-05.ogg");
    expect(recordingFileName(at, "")).toBe("録音 2030-01-02 09-05.webm");
    expect(recordingFileName(at, "audio/x-unknown")).toBeNull();
    expect(extensionForMime("video/webm")).toBe("webm");
    expect(extensionForMime("audio/wav")).toBeNull();
  });

  it("finds nothing outside a browser or without the APIs (unsupported)", () => {
    const env = browserMicEnvironment();
    expect(env.MediaRecorder).toBeUndefined();
  });
});

describe("MicRecorder", () => {
  it("records with the chosen type, collects chunks, and stops with a named File and its length", async () => {
    const { env, streams, instances } = environment();
    const recorder = new MicRecorder(env);
    await recorder.start();
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder.state).toBe("recording");
    expect(instances[0]!.options).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(instances[0]!.timeslice).toBe(1000);
    instances[0]!.emit([1, 2]);
    vi.advanceTimersByTime(65_000);
    expect(recorder.elapsedMs()).toBe(65_000);
    instances[0]!.emit([3]);
    const recording = await recorder.stop();
    expect(recording.file.name).toBe("録音 2030-01-02 09-05.webm");
    expect(recording.file.type).toBe("audio/webm;codecs=opus");
    expect([...new Uint8Array(await recording.file.arrayBuffer())]).toEqual([1, 2, 3, 9]);
    expect(recording.durationSec).toBe(65);
    expect(recorder.state).toBe("stopped");
    expect(streams[0]!.tracks.every((track) => track.stopped)).toBe(true);
    // 止めたあとの経過は止めた時まで
    vi.advanceTimersByTime(10_000);
    expect(recorder.elapsedMs()).toBe(65_000);
  });

  it("uses the browser's default when no candidate is supported, and names an mp4 recording .m4a", async () => {
    const { Recorder } = fakeRecorderClass([], "audio/mp4");
    const { env } = environment({ MediaRecorder: Recorder });
    const recorder = new MicRecorder(env);
    await recorder.start();
    const recording = await recorder.stop();
    expect(recording.file.name).toBe("録音 2030-01-02 09-05.m4a");
  });

  it("tells denied, no microphone, unsupported and other failures apart, and leaves no track running", async () => {
    const reject = (name: string) => vi.fn(async () => Promise.reject(Object.assign(new Error(name), { name })));
    for (const [name, kind] of [
      ["NotAllowedError", "denied"],
      ["SecurityError", "denied"],
      ["NotFoundError", "no_device"],
      ["OverconstrainedError", "no_device"],
      ["NotReadableError", "failed"],
      ["AbortError", "failed"],
    ] as const) {
      const recorder = new MicRecorder(environment({ getUserMedia: reject(name) }).env);
      const error = await recorder.start().catch((caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(MicError);
      expect((error as MicError).kind, name).toBe(kind);
      expect(recorder.state).toBe("idle");
    }
    await expect(new MicRecorder({ MediaRecorder: environment().env.MediaRecorder }).start()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(new MicRecorder({ getUserMedia: environment().env.getUserMedia }).start()).rejects.toMatchObject({ kind: "unsupported" });

    // MediaRecorder が作れない: マイクのトラックを止めてから unsupported
    const { env, streams } = environment({
      MediaRecorder: class {
        constructor() {
          throw Object.assign(new Error("no"), { name: "NotSupportedError" });
        }
      } as unknown as MediaRecorderCtor,
    });
    await expect(new MicRecorder(env).start()).rejects.toMatchObject({ kind: "unsupported" });
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
  });

  it("stops by itself after 6 hours and hands over the recording", async () => {
    const onAutoStop = vi.fn();
    const { env, streams } = environment();
    const recorder = new MicRecorder(env, { onAutoStop });
    await recorder.start();
    vi.advanceTimersByTime(MIC_MAX_DURATION_MS - 1);
    expect(onAutoStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(onAutoStop.mock.calls[0]![0].durationSec).toBe(6 * 60 * 60);
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(MIC_MAX_DURATION_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("keeps the reported length within the limit when the auto-stop timer fires late", async () => {
    const onAutoStop = vi.fn();
    const { env } = environment();
    const recorder = new MicRecorder(env, { onAutoStop });
    await recorder.start();
    vi.advanceTimersByTime(MIC_MAX_DURATION_MS - 1);
    // タイマーが遅れて動いた（その間に時計が 3 秒進んだ）ときも、申告する長さは上限を超えない（超えると取り込みが too_long で断られ続ける）
    vi.setSystemTime(Date.now() + 3000);
    vi.advanceTimersByTime(1);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect(onAutoStop.mock.calls[0]![0].durationSec).toBe(6 * 60 * 60);
  });

  it("does not shorten a recording that ends before the limit", async () => {
    const onAutoStop = vi.fn();
    const { env, instances } = environment();
    const recorder = new MicRecorder(env, { onAutoStop });
    await recorder.start();
    vi.advanceTimersByTime(90_500);
    instances[0]!.emit([1]);
    const recording = await recorder.stop();
    expect(recording.durationSec).toBe(90.5);
  });

  it("stops when the microphone goes away, keeping what was recorded", async () => {
    const onAutoStop = vi.fn();
    const { env, streams, instances } = environment();
    const recorder = new MicRecorder(env, { onAutoStop });
    await recorder.start();
    instances[0]!.emit([5]);
    streams[0]!.tracks[0]!.end();
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(await (onAutoStop.mock.calls[0]![0].file as File).arrayBuffer())]).toEqual([5, 9]);
  });

  it("discards on dispose: stops the tracks, drops the chunks, and clears the 6-hour timer; dispose while asking for permission stops the late stream", async () => {
    const onAutoStop = vi.fn();
    const { env, streams } = environment();
    const recorder = new MicRecorder(env, { onAutoStop });
    await recorder.start();
    recorder.dispose();
    recorder.dispose();
    expect(recorder.state).toBe("disposed");
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    vi.advanceTimersByTime(MIC_MAX_DURATION_MS);
    expect(onAutoStop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    let grant!: (stream: MediaStream) => void;
    const late = new FakeStream();
    const waiting = new MicRecorder({ ...env, getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) });
    const starting = waiting.start();
    waiting.dispose();
    grant(late as unknown as MediaStream);
    await expect(starting).rejects.toBeInstanceOf(MicError);
    expect(late.tracks[0]!.stopped).toBe(true);
  });

  it("reports a recorder error and stops the tracks", async () => {
    const onError = vi.fn();
    const { env, streams, instances } = environment();
    const recorder = new MicRecorder(env, { onError });
    await recorder.start();
    instances[0]!.onerror?.(new Event("error"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" }));
    expect(streams[0]!.tracks[0]!.stopped).toBe(true);
    await expect(recorder.stop()).rejects.toBeInstanceOf(MicError);
  });
});
