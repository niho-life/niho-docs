import { describe, expect, it } from "vitest";
import { contentRange, resolveAudioRange, unsatisfiedContentRange } from "./audio-range";

const TOTAL = 10;
const partial = (start: number, end: number) => ({ kind: "partial", start, end });
const UNSATISFIABLE = { kind: "unsatisfiable" };
const FULL = { kind: "full" };

describe("resolveAudioRange: 範囲 1 つだけの Range（RFC 9110 §14）", () => {
  it("Range が無ければ全体", () => {
    expect(resolveAudioRange(null, TOTAL)).toEqual(FULL);
    expect(resolveAudioRange(null, 0)).toEqual(FULL);
  });

  it("bytes=a-b: 先頭・途中・末尾・1 バイト・全体", () => {
    expect(resolveAudioRange("bytes=0-0", TOTAL)).toEqual(partial(0, 0));
    expect(resolveAudioRange("bytes=0-1", TOTAL)).toEqual(partial(0, 1));
    expect(resolveAudioRange("bytes=2-5", TOTAL)).toEqual(partial(2, 5));
    expect(resolveAudioRange("bytes=9-9", TOTAL)).toEqual(partial(9, 9));
    expect(resolveAudioRange("bytes=0-9", TOTAL)).toEqual(partial(0, 9));
  });

  it("終わりが全体を超えたら、全体の終わりで切る", () => {
    expect(resolveAudioRange("bytes=5-10", TOTAL)).toEqual(partial(5, 9));
    expect(resolveAudioRange("bytes=0-999999", TOTAL)).toEqual(partial(0, 9));
    expect(resolveAudioRange("bytes=3-99999999999999999999999999", TOTAL)).toEqual(partial(3, 9));
  });

  it("bytes=a-: 終わりまで（ブラウザの最初の要求 bytes=0- を含む）", () => {
    expect(resolveAudioRange("bytes=0-", TOTAL)).toEqual(partial(0, 9));
    expect(resolveAudioRange("bytes=7-", TOTAL)).toEqual(partial(7, 9));
    expect(resolveAudioRange("bytes=9-", TOTAL)).toEqual(partial(9, 9));
  });

  it("bytes=-n: 終わりの n バイト。全体より大きければ先頭から", () => {
    expect(resolveAudioRange("bytes=-3", TOTAL)).toEqual(partial(7, 9));
    expect(resolveAudioRange("bytes=-1", TOTAL)).toEqual(partial(9, 9));
    expect(resolveAudioRange("bytes=-10", TOTAL)).toEqual(partial(0, 9));
    expect(resolveAudioRange("bytes=-11", TOTAL)).toEqual(partial(0, 9));
    expect(resolveAudioRange("bytes=-99999999999999999999999999", TOTAL)).toEqual(partial(0, 9));
  });

  it("始まりが全体の大きさ以上・-0・空の音声への範囲は満たせない（416）", () => {
    expect(resolveAudioRange("bytes=10-", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=10-20", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=99999999999999999999-", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=-0", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=0-", 0)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=-5", 0)).toEqual(UNSATISFIABLE);
  });

  it("範囲が 2 つ以上は 416（multipart を返さない）", () => {
    expect(resolveAudioRange("bytes=0-1,4-5", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=0-1, 4-5", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=0-1,", TOTAL)).toEqual(UNSATISFIABLE);
    expect(resolveAudioRange("bytes=-1,-2", TOTAL)).toEqual(UNSATISFIABLE);
  });

  it("形が不正なら 416（終わりが始まりより前・数字でない・空・符号・小数・= が無い）", () => {
    for (const header of [
      "bytes=5-2",
      "bytes=a-b",
      "bytes=1-x",
      "bytes=",
      "bytes=-",
      "bytes=--1",
      "bytes=+1-2",
      "bytes=1.5-2",
      "bytes=1 - 2",
      "bytes",
      "=0-1",
      "",
      "   ",
      "bytes 0-1",
      "by tes=0-1",
    ]) {
      expect(resolveAudioRange(header, TOTAL), header).toEqual(UNSATISFIABLE);
    }
  });

  it("単位は大文字・小文字を区別せず、範囲の前後の空白は許す。bytes 以外の単位（形は正しい）は無視して全体", () => {
    expect(resolveAudioRange("Bytes=2-5", TOTAL)).toEqual(partial(2, 5));
    expect(resolveAudioRange("BYTES=-3", TOTAL)).toEqual(partial(7, 9));
    expect(resolveAudioRange("  bytes= 2-5 ", TOTAL)).toEqual(partial(2, 5));
    expect(resolveAudioRange("items=0-1", TOTAL)).toEqual(FULL);
  });

  it("2 GiB を超える音声でも数が壊れない（安全な整数のまま）", () => {
    const big = 2 * 1024 * 1024 * 1024 + 7; // 2147483655
    expect(resolveAudioRange("bytes=2147483648-", big)).toEqual(partial(2147483648, big - 1));
    expect(resolveAudioRange("bytes=2147483647-2147483650", big)).toEqual(partial(2147483647, 2147483650));
    expect(resolveAudioRange("bytes=-4294967296", big)).toEqual(partial(0, big - 1));
    expect(resolveAudioRange("bytes=-8", big)).toEqual(partial(big - 8, big - 1));
    expect(resolveAudioRange(`bytes=${big}-`, big)).toEqual(UNSATISFIABLE);
    const huge = 6 * 1024 ** 4; // 6 TiB（安全な整数）
    expect(resolveAudioRange("bytes=5497558138880-5497558138889", huge)).toEqual(partial(5497558138880, 5497558138889));
    expect(contentRange(2147483648, big - 1, big)).toBe("bytes 2147483648-2147483654/2147483655");
  });

  it("全体の大きさが整数でなければ呼び出し側の誤り（TypeError）", () => {
    expect(() => resolveAudioRange("bytes=0-1", -1)).toThrow(TypeError);
    expect(() => resolveAudioRange("bytes=0-1", 1.5)).toThrow(TypeError);
    expect(() => resolveAudioRange(null, Number.NaN)).toThrow(TypeError);
  });

  it("Content-Range の形", () => {
    expect(contentRange(2, 5, 10)).toBe("bytes 2-5/10");
    expect(unsatisfiedContentRange(10)).toBe("bytes */10");
  });
});
