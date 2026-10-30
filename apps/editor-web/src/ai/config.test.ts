import { describe, expect, it } from "vitest";
import { monthlyLimitUsd, resolveAiBackend } from "./config";

describe("resolveAiBackend", () => {
  it("is off unless EDITOR_AI_MODE says fake", () => {
    for (const mode of [undefined, "", " ", "off", "OFF", "anthropic", "gemini", "claude", "fake2"]) {
      expect(resolveAiBackend({ EDITOR_AI_MODE: mode }), String(mode)).toBeNull();
      expect(resolveAiBackend({ EDITOR_AI_MODE: mode, NODE_ENV: "development" }), String(mode)).toBeNull();
    }
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
