import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256, sha256Hex } from "./sha256-stream";

const reference = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** 小さな決定的な乱数（分割の位置を再現できるように）。 */
function seeded(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

/** data を split が返す長さずつに分けて流す。 */
function streamed(data: Uint8Array, split: (remaining: number) => number): string {
  const hash = new Sha256();
  let offset = 0;
  while (offset < data.length) {
    const size = Math.max(1, Math.min(data.length - offset, split(data.length - offset)));
    hash.update(data.subarray(offset, offset + size));
    offset += size;
  }
  return hash.digest();
}

describe("Sha256（逐次）", () => {
  it("matches the known vectors (FIPS 180-4 / NIST)", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(text("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    // 100 万個の "a"（1 バイトずつではなく、塊で）
    const million = new Uint8Array(1_000_000).fill(0x61);
    expect(streamed(million, () => 4096)).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("matches node:crypto at the block boundaries: empty, 1, 55, 56, 63, 64, 65 bytes and around 128", () => {
    for (const length of [0, 1, 2, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const data = new Uint8Array(randomBytes(length));
      const expected = reference(data);
      expect(sha256Hex(data), `${length} at once`).toBe(expected);
      expect(streamed(data, () => 1), `${length} byte by byte`).toBe(expected);
    }
  });

  it("matches node:crypto for random inputs split at random places (byte by byte, small and large pieces)", () => {
    const next = seeded(20301031);
    for (let round = 0; round < 60; round += 1) {
      const data = new Uint8Array(randomBytes(next(5000)));
      const expected = reference(data);
      expect(streamed(data, () => 1 + next(3)), `round ${round} tiny`).toBe(expected);
      expect(streamed(data, () => 1 + next(200)), `round ${round} small`).toBe(expected);
      expect(streamed(data, (remaining) => 1 + next(remaining)), `round ${round} large`).toBe(expected);
      expect(streamed(data, () => 64), `round ${round} aligned`).toBe(expected);
    }
  });

  it("matches node:crypto over 5 MiB, fed in uneven chunks", () => {
    const data = new Uint8Array(randomBytes(5 * 1024 * 1024 + 4321));
    const next = seeded(7);
    expect(streamed(data, () => 1 + next(1024 * 1024))).toBe(reference(data));
    expect(streamed(data, () => 4 * 1024 * 1024)).toBe(reference(data));
  });

  it("ignores empty updates and refuses to be used after digest", () => {
    const hash = new Sha256();
    hash.update(new Uint8Array(0)).update(new Uint8Array([0x61, 0x62])).update(new Uint8Array(0)).update(new Uint8Array([0x63]));
    expect(hash.digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(() => hash.update(new Uint8Array([1]))).toThrow();
    expect(() => hash.digest()).toThrow();
  });
});
