import { describe, expect, it } from "vitest";
import {
  MASKED_KEY_PREFIX,
  MAX_AUTHORIZATION_LENGTH,
  isConnectionKey,
  isPreviewToken,
  maskKey,
  parseBearer,
} from "../src/keys.js";
import { createRng, syntheticKey, syntheticPreviewToken } from "./support/synthetic.js";

const rng = createRng(2);
const key = syntheticKey(rng);
const token = syntheticPreviewToken(rng);

describe("credential shapes", () => {
  it("accepts ek_ / pv_ with 43 canonical base64url characters", () => {
    expect(isConnectionKey(`ek_${"A".repeat(43)}`)).toBe(true);
    expect(isConnectionKey(key)).toBe(true);
    expect(isPreviewToken(token)).toBe(true);
    expect(isConnectionKey(token)).toBe(false);
    expect(isPreviewToken(key)).toBe(false);
  });

  it("rejects wrong length, alphabet, padding and non-canonical endings", () => {
    for (const value of [
      `ek_${"A".repeat(42)}`,
      `ek_${"A".repeat(44)}`,
      `ek_${"A".repeat(42)}B`,
      `ek_${"A".repeat(42)}=`,
      `ek_${"A".repeat(41)}+A`,
      `EK_${"A".repeat(43)}`,
      ` ek_${"A".repeat(43)}`,
      "",
      null,
      42,
    ]) {
      expect(isConnectionKey(value)).toBe(false);
    }
  });

  it("masks keys to the prefix and the last 4 characters only", () => {
    const masked = maskKey(key);
    expect(masked).toBe(`${MASKED_KEY_PREFIX}${key.slice(-4)}`);
    expect(masked.startsWith("ek_••••••••")).toBe(true);
    expect(masked).not.toContain(key.slice(3, -4));
    expect(maskKey("not-a-key-but-maybe-secret")).toBe(MASKED_KEY_PREFIX);
    expect(maskKey(token)).toBe(MASKED_KEY_PREFIX);
  });
});

describe("parseBearer", () => {
  it("returns the credential of a single Bearer value", () => {
    expect(parseBearer(`Bearer ${key}`)).toBe(key);
    expect(parseBearer([`Bearer ${key}`])).toBe(key);
    expect(parseBearer(`bearer ${key}`)).toBe(key);
  });

  it("returns null for anything else", () => {
    for (const header of [
      undefined,
      null,
      "",
      "Bearer",
      "Bearer ",
      `Basic ${key}`,
      `Bearer  ${key}`,
      ` Bearer ${key}`,
      `Bearer ${key} `,
      `Bearer ${key}, Bearer ${key}`,
      `Bearer ${key},${key}`,
      [`Bearer ${key}`, `Bearer ${key}`],
      [],
      `Bearer ${"a".repeat(MAX_AUTHORIZATION_LENGTH)}`,
      `Bearer ab\ncd`,
    ]) {
      expect(parseBearer(header)).toBeNull();
    }
  });
});
