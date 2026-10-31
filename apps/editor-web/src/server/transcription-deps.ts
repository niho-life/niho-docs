import "server-only";
import { resolveTranscriptionTasksConfig } from "../transcription/cloud-tasks";
import { resolveDispatcherKind } from "../transcription/dispatch";
import { getTranscriptionWorkerRunner } from "../transcription/runtime";
import { getPool } from "./db";
import { verifyGoogleOidc } from "./google-oidc";
import type { TranscriptionWorkerDeps } from "./transcription-worker-api";

/**
 * `/api/internal/transcription/**`（文字起こしの worker の route）の実行時の依存。方式が cloud-tasks のときだけ開く
 * （手順の steps-deps.ts と同じ形）。DB の接続・方式は要求のたびに遅延して決める。
 */
export const transcriptionWorkerDeps: TranscriptionWorkerDeps = {
  config: () => (resolveDispatcherKind(process.env) === "cloud-tasks" ? resolveTranscriptionTasksConfig(process.env) : null),
  verify: (token, expected) => verifyGoogleOidc(token, expected),
  runner: () => {
    const pool = getPool();
    return pool ? getTranscriptionWorkerRunner(pool, process.env) : null;
  },
};
