import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTranscriptionRunner } from "./runtime";

// Pool は開始の準備では使わない（実行するときだけ使う）
const pool = {} as unknown as Pool;
const KEY = "test-key-not-secret";

describe("getTranscriptionRunner", () => {
  it("prepares the inline dispatcher with the fake engine outside production", () => {
    const runner = getTranscriptionRunner(pool, { NODE_ENV: "development" });
    expect(runner?.engine).toBe("fake");
    expect(runner?.dispatcher.kind).toBe("inline");
    expect(getTranscriptionRunner(pool, { NODE_ENV: "test", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY })?.engine).toBe("deepgram");
  });

  it("has nothing in production (no dispatcher until Cloud Tasks and the worker exist), when off, misconfigured, or without storage", () => {
    expect(getTranscriptionRunner(pool, { NODE_ENV: "production" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: "synthetic-test-bucket" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "fake" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "off" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "whisper" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "deepgram" })).toBeNull();
    expect(getTranscriptionRunner(pool, { NODE_ENV: "development", EDITOR_STORAGE: "off" })).toBeNull();
  });
});
