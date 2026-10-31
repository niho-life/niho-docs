/**
 * 文字起こしのエンジン（`EDITOR_TRANSCRIBE_ENGINE`）・Deepgram の鍵（`DEEPGRAM_API_KEY`）・時間切れ（`EDITOR_TRANSCRIBE_TIMEOUT_SEC`）。
 * 要求のたびに読む（import 時・`next build` 時に固めない）。本番の守りは保存先（src/storage/config.ts）と同じ形:
 *
 * - `fake`: 決定的な偽物（開発と CI だけ）。`NODE_ENV=production` では受け付けない（起動を止める。偽物の文字起こしを本番のページに書かない）。
 * - `deepgram`: Deepgram（src/transcription/deepgram.ts）。`DEEPGRAM_API_KEY` が必須で、無い・形が不正（前後の空白を除いたあとに空白・改行・
 *   制御文字を含む）なら起動を止める。前後の空白（Secret Manager の値の末尾の改行など）は除いて使う（#38 の Anthropic の鍵と同じ）。
 * - `off`: 使わない（開始の API は 503 `transcription_unavailable`）。
 * - 未設定・空: 本番は `off`、それ以外は `fake`。
 * - それ以外の値: 誤り（起動を止める）。
 * - `EDITOR_TRANSCRIBE_TIMEOUT_SEC`: 1 回の文字起こしの時間切れ（秒）。既定 1200（20 分）、60〜3300 の整数。範囲の外・整数でなければ誤り。
 *
 * 本番の守りは 2 か所: 起動時の検査（src/startup-check.ts。誤りなら process を終える）と、要求ごとの解決（src/transcription/runtime.ts。
 * 誤りなら文字起こしなし＝503）。エラーのメッセージには値（鍵）を入れない。鍵は戻り値の関数の中だけに持つ
 * （戻り値を JSON.stringify・文字列にしても鍵は出ない）。
 */

export const TRANSCRIBE_ENGINE_MODES = ["fake", "deepgram", "off"] as const;
export type TranscribeEngineMode = (typeof TRANSCRIBE_ENGINE_MODES)[number];

export const TRANSCRIBE_TIMEOUT_DEFAULT_SEC = 1200;
export const TRANSCRIBE_TIMEOUT_MIN_SEC = 60;
export const TRANSCRIBE_TIMEOUT_MAX_SEC = 3300;

export type TranscriptionEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_TRANSCRIBE_ENGINE?: string | undefined;
  readonly DEEPGRAM_API_KEY?: string | undefined;
  readonly EDITOR_TRANSCRIBE_TIMEOUT_SEC?: string | undefined;
};

export type TranscriptionConfig =
  | { engine: "off" }
  | { engine: "fake"; timeoutMs: number }
  /** apiKey は鍵を返す関数（値は関数の中にだけ持つ）。 */
  | { engine: "deepgram"; timeoutMs: number; apiKey: () => string };

export class TranscriptionConfigError extends Error {
  override readonly name = "TranscriptionConfigError";
}

/** 鍵として受け付ける形（前後の空白を除いたあと、空白・改行・制御文字なしの 1〜512 文字）。 */
const API_KEY = /^[\x21-\x7e]{1,512}$/;

function isMode(value: string): value is TranscribeEngineMode {
  return (TRANSCRIBE_ENGINE_MODES as readonly string[]).includes(value);
}

function timeoutSec(env: TranscriptionEnv): number {
  const raw = env.EDITOR_TRANSCRIBE_TIMEOUT_SEC?.trim() ?? "";
  if (raw === "") return TRANSCRIBE_TIMEOUT_DEFAULT_SEC;
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < TRANSCRIBE_TIMEOUT_MIN_SEC || value > TRANSCRIBE_TIMEOUT_MAX_SEC) {
    throw new TranscriptionConfigError(
      `EDITOR_TRANSCRIBE_TIMEOUT_SEC must be an integer between ${TRANSCRIBE_TIMEOUT_MIN_SEC} and ${TRANSCRIBE_TIMEOUT_MAX_SEC}`,
    );
  }
  return value;
}

/** 文字起こしの方式を決める。誤りは TranscriptionConfigError（値を含めない）。 */
export function resolveTranscriptionConfig(env: TranscriptionEnv): TranscriptionConfig {
  const raw = env.EDITOR_TRANSCRIBE_ENGINE?.trim() ?? "";
  if (raw !== "" && !isMode(raw)) throw new TranscriptionConfigError("EDITOR_TRANSCRIBE_ENGINE must be one of: fake, deepgram, off");
  const production = env.NODE_ENV === "production";
  if (raw === "fake" && production) {
    throw new TranscriptionConfigError(
      "EDITOR_TRANSCRIBE_ENGINE=fake is not allowed when NODE_ENV=production (the fake engine is for development and CI only)",
    );
  }
  // 時間切れの誤りは、使わない設定（off）でも誤り（設定の間違いを黙って通さない）
  const timeoutMs = timeoutSec(env) * 1000;
  if (raw === "deepgram") {
    const key = env.DEEPGRAM_API_KEY?.trim() ?? "";
    if (key === "") throw new TranscriptionConfigError("DEEPGRAM_API_KEY is required when EDITOR_TRANSCRIBE_ENGINE=deepgram");
    if (!API_KEY.test(key)) throw new TranscriptionConfigError("DEEPGRAM_API_KEY is not a valid key");
    return { engine: "deepgram", timeoutMs, apiKey: () => key };
  }
  if (raw === "off") return { engine: "off" };
  if (raw === "fake") return { engine: "fake", timeoutMs };
  return production ? { engine: "off" } : { engine: "fake", timeoutMs };
}
