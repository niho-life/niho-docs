// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RATE_LIMIT, parseRateLimit, rateLimitFromEnv } from "./rate-limit";
import { faceCredentialsFromEnv, faceCredentialSource, parseFaceCredentials } from "./source";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EXP_TOKEN = "st_synthetic-exp-token";
const NIHO_TOKEN = "st_synthetic-niho-token";
const NOW = "2026-10-01T00:00:00.000Z";

const entry = (audience: string, token: string, expiresAt = "2026-10-01T01:00:00.000Z") => ({ audience, sha256: sha(token), expiresAt });

describe("EDITOR_FACE_CREDENTIALS", () => {
  it("maps a token's SHA-256 to its audience until it expires", () => {
    const parsed = parseFaceCredentials(JSON.stringify([entry("exp", EXP_TOKEN), entry("niho", NIHO_TOKEN, NOW)]));
    if (parsed === "unset" || parsed === "invalid") throw new Error("expected entries");
    const faces = faceCredentialSource(parsed);
    expect(faces.audienceByHash(sha(EXP_TOKEN), NOW)).toBe("exp");
    expect(faces.audienceByHash(sha(EXP_TOKEN), "2026-10-01T01:00:00.000Z")).toBeNull();
    // 期限がちょうど今なら切れている
    expect(faces.audienceByHash(sha(NIHO_TOKEN), NOW)).toBeNull();
    expect(faces.audienceByHash(sha("st_unknown"), NOW)).toBeNull();
    // 平文では引けない
    expect(faces.audienceByHash(EXP_TOKEN, NOW)).toBeNull();
  });

  it("is unset when missing or blank, and invalid as a whole when any entry is off", () => {
    expect(parseFaceCredentials(undefined)).toBe("unset");
    expect(parseFaceCredentials("  ")).toBe("unset");
    expect(parseFaceCredentials("[]")).toEqual([]);
    const good = entry("exp", EXP_TOKEN);
    for (const value of [
      "not json",
      "{}",
      JSON.stringify(good),
      JSON.stringify([good, { ...good, audience: "site" }]),
      JSON.stringify([{ ...good, audience: "EXP" }]),
      JSON.stringify([{ ...good, sha256: good.sha256.toUpperCase() }]),
      JSON.stringify([{ ...good, sha256: "abc" }]),
      JSON.stringify([{ ...good, expiresAt: "2026-10-01" }]),
      JSON.stringify([{ ...good, expiresAt: "2026-10-01T01:00:00+09:00" }]),
      JSON.stringify([{ ...good, token: EXP_TOKEN }]),
      JSON.stringify([{ audience: good.audience, sha256: good.sha256 }]),
      JSON.stringify([good, good]),
      JSON.stringify([null]),
    ]) {
      expect(parseFaceCredentials(value), value).toBe("invalid");
    }
  });

  it("lets nobody in when unset or invalid, and logs only that the value is invalid", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const secretish = JSON.stringify([{ ...entry("exp", EXP_TOKEN), note: "do-not-log-me" }]);
      const invalid = faceCredentialsFromEnv({ EDITOR_FACE_CREDENTIALS: secretish });
      expect(invalid.audienceByHash(sha(EXP_TOKEN), NOW)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(["editor-web: EDITOR_FACE_CREDENTIALS is invalid"]);
      // 同じ値なら読み直さない（要求のたびにログを出さない）
      faceCredentialsFromEnv({ EDITOR_FACE_CREDENTIALS: secretish });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(faceCredentialsFromEnv({}).audienceByHash(sha(EXP_TOKEN), NOW)).toBeNull();
      const valid = faceCredentialsFromEnv({ EDITOR_FACE_CREDENTIALS: JSON.stringify([entry("exp", EXP_TOKEN)]) });
      expect(valid.audienceByHash(sha(EXP_TOKEN), NOW)).toBe("exp");
      expect(JSON.stringify(spy.mock.calls)).not.toContain("do-not-log-me");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE", () => {
  it("reads a positive integer per minute and falls back to the generous default", () => {
    expect(parseRateLimit("120")).toEqual({ limit: 120, windowMs: 60_000 });
    expect(rateLimitFromEnv({})).toEqual(DEFAULT_RATE_LIMIT);
    for (const value of ["0", "-1", "1.5", "abc", "0120", "9999999999"]) {
      expect(parseRateLimit(value), value).toBe("invalid");
      expect(rateLimitFromEnv({ EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE: value })).toEqual(DEFAULT_RATE_LIMIT);
    }
  });
});
