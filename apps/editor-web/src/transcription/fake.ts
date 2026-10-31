import { EngineError, type EngineErrorCode, type EngineInput, type EngineResult, type TranscriptionEngine } from "./engine";

/**
 * 決定的な偽のエンジン（開発と CI だけ。本番では src/transcription/config.ts が受け付けない）。
 * 音声は最後まで読んで捨て、固定の段落 3 つ（話者 2 人）を返す。話者は Deepgram と同じく 0 始まりの生の番号で返す
 * （保存の形への正規化（normalize.ts）を、偽物の経路でも通すため）。本文には `[fake]` の印を付ける。
 *
 * 失敗の試験: 環境変数 `EDITOR_TRANSCRIBE_FAKE_FAIL`（unavailable・rejected・timeout・bad_response）を設定すると、音声を読んだあとに
 * その EngineError で失敗する（e2e で「失敗 → もう一度」を確かめる。本番では偽物が起動しないので無害）。
 */

export const FAKE_TRANSCRIBE_FAIL_ENV = "EDITOR_TRANSCRIBE_FAKE_FAIL";

/** 偽物を失敗させられる code。 */
export const FAKE_FAIL_CODES: readonly EngineErrorCode[] = ["unavailable", "rejected", "timeout", "bad_response"];

/** 環境変数から失敗させる code を読む（未設定・未知の値は失敗させない）。 */
export function fakeFailFromEnv(env: Readonly<Record<string, string | undefined>>): EngineErrorCode | null {
  const raw = env[FAKE_TRANSCRIBE_FAIL_ENV]?.trim() ?? "";
  return (FAKE_FAIL_CODES as readonly string[]).includes(raw) ? (raw as EngineErrorCode) : null;
}

const TEXTS: Record<"ja" | "en", readonly [string, string, string]> = {
  ja: ["[fake] 合成の文字起こしの一つ目の段落です。", "[fake] 二つ目の段落は別の話者です。", "[fake] 三つ目の段落で最初の話者に戻ります。"],
  en: ["[fake] This is the first synthetic paragraph.", "[fake] The second paragraph is another speaker.", "[fake] The third paragraph returns to the first speaker."],
};

/** 偽物の結果（言語ごとに固定）。 */
export function fakeEngineResult(language: "ja" | "en"): EngineResult {
  const [first, second, third] = TEXTS[language];
  return {
    segments: [
      { start: 0, end: 3, text: first, speaker: 0 },
      { start: 3, end: 6, text: second, speaker: 1 },
      { start: 6, end: 9, text: third, speaker: 0 },
    ],
    durationSec: 9,
  };
}

async function drain(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new EngineError("timeout");
      }
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createFakeEngine(options: { failWith?: EngineErrorCode | null } = {}): TranscriptionEngine {
  const failWith = options.failWith ?? null;
  return {
    name: "fake",
    async transcribe(input: EngineInput): Promise<EngineResult> {
      await drain(input.audio.stream, input.signal);
      if (failWith) throw new EngineError(failWith);
      return fakeEngineResult(input.language);
    },
  };
}
