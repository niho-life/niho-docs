import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTranscriptionRunner, getTranscriptionWorkerRunner } from "./runtime";

// Pool は開始の準備では使わない（実行するときだけ使う）
const pool = {} as unknown as Pool;
const KEY = "test-key-not-secret";
// 合成の値だけ（本物のプロジェクト・URL・メール・bucket を入れない）
const PRODUCTION = {
  NODE_ENV: "production",
  EDITOR_TRANSCRIBE_ENGINE: "deepgram",
  DEEPGRAM_API_KEY: KEY,
  EDITOR_STORAGE: "gcs",
  EDITOR_ASSETS_BUCKET: "synthetic-test-bucket",
} as const;
const TASKS_ENV = {
  EDITOR_TRANSCRIBE_MODE: "cloud-tasks",
  EDITOR_TRANSCRIBE_QUEUE: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-transcribe",
  EDITOR_TRANSCRIBE_WORKER_URL: "https://worker.example.test",
  EDITOR_TRANSCRIBE_INVOKER_SA: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
} as const;

describe("getTranscriptionRunner", () => {
  it("prepares the inline dispatcher with the fake engine outside production", () => {
    const runner = getTranscriptionRunner(pool, { NODE_ENV: "development" });
    expect(runner?.engine).toBe("fake");
    expect(runner?.dispatcher.kind).toBe("inline");
    expect(getTranscriptionRunner(pool, { NODE_ENV: "test", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY })?.engine).toBe("deepgram");
  });

  it("prepares the Cloud Tasks dispatcher in production when the mode and the queue are set", () => {
    const runner = getTranscriptionRunner(pool, { ...PRODUCTION, ...TASKS_ENV });
    expect(runner?.engine).toBe("deepgram");
    expect(runner?.dispatcher.kind).toBe("cloud-tasks");
  });

  it("opens the worker only for cloud-tasks", () => {
    const worker = getTranscriptionWorkerRunner(pool, { ...PRODUCTION, ...TASKS_ENV });
    expect(worker?.timeoutSec).toBe(1200);
    expect(getTranscriptionWorkerRunner(pool, { ...PRODUCTION, ...TASKS_ENV, EDITOR_TRANSCRIBE_TIMEOUT_SEC: "600" })?.timeoutSec).toBe(600);
    // inline は要求の中で走るので worker を使わない
    expect(getTranscriptionWorkerRunner(pool, { NODE_ENV: "development" })).toBeNull();
    expect(getTranscriptionWorkerRunner(pool, PRODUCTION)).toBeNull();
    expect(getTranscriptionWorkerRunner(pool, { ...PRODUCTION, ...TASKS_ENV, EDITOR_TRANSCRIBE_QUEUE: undefined })).toBeNull();
    // 鍵が無い・保存先を使わない設定では、worker も開かない（503 で Cloud Tasks が再試行する）
    expect(getTranscriptionWorkerRunner(pool, { ...PRODUCTION, ...TASKS_ENV, DEEPGRAM_API_KEY: undefined })).toBeNull();
    expect(getTranscriptionWorkerRunner(pool, { ...PRODUCTION, ...TASKS_ENV, EDITOR_STORAGE: "off" })).toBeNull();
  });

  it("has nothing in production without a dispatcher, when off, misconfigured, or without storage", () => {
    expect(getTranscriptionRunner(pool, { NODE_ENV: "production" })).toBeNull();
    expect(getTranscriptionRunner(pool, PRODUCTION)).toBeNull();
    // 方式が cloud-tasks でも、キューの 3 つが揃わなければ閉じたまま
    expect(getTranscriptionRunner(pool, { ...PRODUCTION, ...TASKS_ENV, EDITOR_TRANSCRIBE_INVOKER_SA: undefined })).toBeNull();
    // 呼び出し口があっても、鍵が無ければエンジンは開かない
    expect(getTranscriptionRunner(pool, { ...PRODUCTION, ...TASKS_ENV, DEEPGRAM_API_KEY: undefined })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "fake" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "off" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "whisper" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "deepgram" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_STORAGE: "off" })).toBeNull();
  });
});
