import "server-only";
import { failRun, type Connectable, type Queryable } from "@niho/editor-store";
import { getStorage } from "../storage/runtime";
import { resolveTranscriptionConfig, type TranscriptionEnv } from "./config";
import { createDeepgramEngine } from "./deepgram";
import { createInlineDispatcher, resolveDispatcherKind, type TranscriptionDispatcher } from "./dispatch";
import type { TranscriptionEngine, TranscriptionEngineName } from "./engine";
import { createFakeEngine, fakeFailFromEnv } from "./fake";
import { executeRun, pgTranscriptionRunStore } from "./run";

/** 開始の API が使うもの: run に記録するエンジンの名前と、実行の呼び出し口。 */
export type TranscriptionRunner = { engine: TranscriptionEngineName; dispatcher: TranscriptionDispatcher };

/**
 * 要求ごとの文字起こしの実行の準備（`EDITOR_TRANSCRIBE_ENGINE` などを毎回読む）。使えないときは null（開始の API は 503
 * `transcription_unavailable`）: `off`・設定の誤り・本番（呼び出し口がまだ無い）・保存先を使わない設定。
 * 設定の誤りは起動時の検査（src/startup-check.ts）が先に止めるので、ここは後ろの守り（値を出さずに null）。
 */
export function getTranscriptionRunner(pool: Connectable & Queryable, env: TranscriptionEnv & Readonly<Record<string, string | undefined>> = process.env): TranscriptionRunner | null {
  let config;
  try {
    config = resolveTranscriptionConfig(env);
  } catch {
    return null;
  }
  if (config.engine === "off") return null;
  if (resolveDispatcherKind(env) !== "inline") return null;
  const storage = getStorage(env);
  if (!storage) return null;
  const engine: TranscriptionEngine =
    config.engine === "deepgram"
      ? createDeepgramEngine({ apiKey: config.apiKey, timeoutMs: config.timeoutMs })
      : createFakeEngine({ failWith: fakeFailFromEnv(env) });
  const store = pgTranscriptionRunStore(pool);
  const dispatcher = createInlineDispatcher({
    execute: (runId) => executeRun({ store, storage, engine, runId, timeoutMs: config.timeoutMs }),
    failQueued: (runId) => failRun(pool, runId, 0, "internal"),
  });
  return { engine: engine.name, dispatcher };
}
