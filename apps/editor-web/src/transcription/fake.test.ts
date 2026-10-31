import { describe, expect, it } from "vitest";
import { EngineError, type EngineInput } from "./engine";
import { FAKE_TRANSCRIBE_FAIL_ENV, createFakeEngine, fakeEngineResult, fakeFailFromEnv } from "./fake";
import { normalizeEngineResult } from "./normalize";

function tracked(bytes = new Uint8Array([1, 2, 3])) {
  const state = { pulled: false, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled = true;
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function input(stream: ReadableStream<Uint8Array>, extra: Partial<EngineInput> = {}): EngineInput {
  return { audio: { stream, contentType: "audio/mp4", sizeBytes: 3 }, language: "ja", diarize: true, terms: [], signal: new AbortController().signal, ...extra };
}

describe("fake engine", () => {
  it("reads the audio to the end and returns three fixed paragraphs of two speakers with zero-based numbers", async () => {
    const { stream, state } = tracked();
    const engine = createFakeEngine();
    expect(engine.name).toBe("fake");
    const result = await engine.transcribe(input(stream));
    expect(state.pulled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(result).toEqual(fakeEngineResult("ja"));
    expect(result.segments.map((segment) => segment.speaker)).toEqual([0, 1, 0]);
    expect(result.segments.every((segment) => segment.text.startsWith("[fake] "))).toBe(true);
    // 正規化すると 1 始まり
    expect(normalizeEngineResult(result, { diarize: true }).segments.map((segment) => segment.speaker)).toEqual([1, 2, 1]);
    expect((await createFakeEngine().transcribe(input(tracked().stream, { language: "en" }))).segments[0]?.text).toMatch(/^\[fake\] This is/);
  });

  it("fails with the code from EDITOR_TRANSCRIBE_FAKE_FAIL after reading the audio", async () => {
    expect(FAKE_TRANSCRIBE_FAIL_ENV).toBe("EDITOR_TRANSCRIBE_FAKE_FAIL");
    for (const code of ["unavailable", "rejected", "timeout", "bad_response"] as const) {
      expect(fakeFailFromEnv({ EDITOR_TRANSCRIBE_FAKE_FAIL: code })).toBe(code);
      const { stream, state } = tracked();
      await expect(createFakeEngine({ failWith: fakeFailFromEnv({ EDITOR_TRANSCRIBE_FAKE_FAIL: ` ${code} ` }) }).transcribe(input(stream))).rejects.toMatchObject({
        name: "EngineError",
        code,
      });
      expect(state.pulled).toBe(true);
    }
    for (const value of [undefined, "", "too_large", "UNAVAILABLE", "internal"]) expect(fakeFailFromEnv({ EDITOR_TRANSCRIBE_FAKE_FAIL: value })).toBeNull();
  });

  it("stops with timeout when the caller has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream } = tracked();
    await expect(createFakeEngine().transcribe(input(stream, { signal: controller.signal }))).rejects.toBeInstanceOf(EngineError);
  });
});
