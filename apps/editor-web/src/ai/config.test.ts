import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_URL } from "./anthropic";
import { DEFAULT_ANTHROPIC_MODEL, monthlyLimitUsd, resolveAiBackend, type AiEnv } from "./config";
import type { AiRequest } from "./model";

// 合成の鍵（本物の API は呼ばない。fetch は global を差し替える）
const KEY = "synthetic-anthropic-key-0123456789";

const sample: AiRequest = { intent: { preset: "tidy" }, paragraphs: [{ index: 0, kind: "paragraph", text: "合成" }], glossary: [], lang: "ja" };

/** global の fetch を差し替え、本物のバックエンドで 1 回提案させて、送った要求を返す。 */
async function sentWith(env: AiEnv): Promise<{ url: string; model: unknown; key: string | null }> {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"edits":[],"inserts":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  vi.stubGlobal("fetch", fetch);
  const backend = resolveAiBackend(env);
  if (!backend) throw new Error("expected a backend");
  await backend.model.run(sample);
  const [input, init] = fetch.mock.calls[0]!;
  return { url: String(input), model: (JSON.parse(String(init?.body)) as { model: unknown }).model, key: new Headers(init?.headers).get("x-api-key") };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveAiBackend", () => {
  it("is off unless EDITOR_AI_MODE says fake or anthropic (with a key)", () => {
    for (const mode of [undefined, "", " ", "off", "OFF", "anthropic", "Anthropic", "gemini", "claude", "fake2"]) {
      expect(resolveAiBackend({ EDITOR_AI_MODE: mode }), String(mode)).toBeNull();
      expect(resolveAiBackend({ EDITOR_AI_MODE: mode, NODE_ENV: "development" }), String(mode)).toBeNull();
    }
    // 鍵があっても、未知の方式は使わない
    for (const mode of ["Anthropic", "claude", "openai"]) expect(resolveAiBackend({ EDITOR_AI_MODE: mode, ANTHROPIC_API_KEY: KEY }), mode).toBeNull();
  });

  it("uses the fake model in development and test, with no price table", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      const backend = resolveAiBackend({ EDITOR_AI_MODE: " fake ", NODE_ENV });
      expect(backend?.provider, String(NODE_ENV)).toBeNull();
      expect(typeof backend?.model.run).toBe("function");
    }
  });

  it("refuses the fake model in production (no fake proposals for real users)", () => {
    expect(resolveAiBackend({ EDITOR_AI_MODE: "fake", NODE_ENV: "production" })).toBeNull();
  });

  it("uses Anthropic with the claude price table when the key is set, in production too", async () => {
    for (const NODE_ENV of [undefined, "development", "production"]) {
      const backend = resolveAiBackend({ EDITOR_AI_MODE: " anthropic ", ANTHROPIC_API_KEY: KEY, NODE_ENV });
      expect(backend?.provider, String(NODE_ENV)).toBe("claude");
    }
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    expect(await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY })).toEqual({ url: ANTHROPIC_MESSAGES_URL, model: "claude-sonnet-5-5", key: KEY });
    expect((await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL: "  " })).model).toBe("claude-sonnet-5-5");
    expect((await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL: " claude-opus-5-5 " })).model).toBe("claude-opus-5-5");
  });

  it("stays closed (null) without a key or with a model name of the wrong shape", () => {
    for (const ANTHROPIC_API_KEY of [undefined, "", "   "]) {
      expect(resolveAiBackend({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY, NODE_ENV: "production" }), String(ANTHROPIC_API_KEY)).toBeNull();
    }
    for (const EDITOR_AI_MODEL of ["Claude-Sonnet", "-claude", "claude sonnet", "claude/../v1", "claude\nx", "claude:latest", "a".repeat(65), "クロード"]) {
      expect(resolveAiBackend({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL }), EDITOR_AI_MODEL).toBeNull();
    }
    expect(resolveAiBackend({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL: `a${"b".repeat(63)}` })?.provider).toBe("claude");
  });
});

describe("monthlyLimitUsd", () => {
  it("is unlimited when unset and reads a non-negative number", () => {
    expect(monthlyLimitUsd({})).toBeNull();
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: "" })).toBeNull();
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: " 12.5 " })).toBe(12.5);
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: "0" })).toBe(0);
  });

  it("falls back to 0 (AI stopped) for a value that is not a non-negative number", () => {
    for (const value of ["abc", "-1", "Infinity", "NaN", "1e400", "$5"]) expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: value }), value).toBe(0);
  });
});
