import { describe, expect, it } from "vitest";
import { MAX_DIFF_CELLS, diffAfter, diffBefore, diffWords, tokenize, type DiffPart } from "./diff";

function expectRoundTrip(before: string, after: string): DiffPart[] {
  const parts = diffWords(before, after);
  expect(diffBefore(parts), "before").toBe(before);
  expect(diffAfter(parts), "after").toBe(after);
  // 隣り合う同種の部分は結合している・空の部分は無い
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const kind = typeof part === "string" ? "same" : "del" in part ? "del" : "ins";
    const text = typeof part === "string" ? part : "del" in part ? part.del : part.ins;
    expect(text.length, JSON.stringify(parts)).toBeGreaterThan(0);
    const next = parts[i + 1];
    if (next !== undefined) {
      const nextKind = typeof next === "string" ? "same" : "del" in next ? "del" : "ins";
      expect(nextKind, JSON.stringify(parts)).not.toBe(kind);
    }
  }
  return parts;
}

describe("diffWords", () => {
  it("splits Japanese and English into words, spaces and punctuation that join back to the text", () => {
    const text = "今日は晴れです。Hello  world, it's fine!\n次の行";
    expect(tokenize(text).join("")).toBe(text);
    expect(tokenize("今日は晴れです。")).toEqual(["今日", "は", "晴れ", "です", "。"]);
  });

  it("marks the changed Japanese words only", () => {
    const parts = expectRoundTrip("今日は晴れです。", "今日は雨です。");
    expect(parts).toEqual(["今日は", { del: "晴れ" }, { ins: "雨" }, "です。"]);
  });

  it("marks the changed English words only", () => {
    const parts = expectRoundTrip("The quick brown fox jumps.", "The quick red fox leaps.");
    expect(parts).toEqual(["The quick ", { del: "brown" }, { ins: "red" }, " fox ", { del: "jumps" }, { ins: "leaps" }, "."]);
  });

  it("handles empty, identical, pure insertions and pure deletions", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("同じ文。", "同じ文。")).toEqual(["同じ文。"]);
    expect(expectRoundTrip("", "足す文。")).toEqual([{ ins: "足す文。" }]);
    expect(expectRoundTrip("消す文。", "")).toEqual([{ del: "消す文。" }]);
    expect(expectRoundTrip("合成の文", "合成の文。")).toEqual(["合成の文", { ins: "。" }]);
    expect(expectRoundTrip("[fake EN] a", "a")).toEqual([{ del: "[fake EN] " }, "a"]);
  });

  it("puts one deletion before one insertion between unchanged parts", () => {
    const parts = expectRoundTrip("一 二 三 四", "一 五 六 四");
    expect(parts).toEqual(["一 ", { del: "二" }, { ins: "五" }, " ", { del: "三" }, { ins: "六" }, " 四"]);
  });

  it("restores before and after for many synthetic pairs", () => {
    const pool = ["今日", "は", "晴れ", "雨", "です", "。", "、", " ", "NIHO", "editor", "a", "b", "\n", "鎌倉", "の", "家"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const sentence = () => Array.from({ length: Math.floor(random() * 20) }, () => pool[Math.floor(random() * pool.length)]).join("");
    for (let i = 0; i < 300; i++) expectRoundTrip(sentence(), sentence());
  });

  it("falls back to delete-all / insert-all when the LCS table would be too large", () => {
    const words = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
    const before = words("a", 1500);
    const after = words("b", 1500);
    expect(tokenize(before).length * tokenize(after).length).toBeGreaterThan(MAX_DIFF_CELLS);
    const parts = expectRoundTrip(before, after);
    expect(parts).toEqual([{ del: before }, { ins: after }]);
    // 前後の共通部分は外してから数える（共通部分は変わらない部分のまま）
    const wrapped = expectRoundTrip(`共通の始まり ${before} 共通の終わり`, `共通の始まり ${after} 共通の終わり`);
    expect(wrapped[0]).toBe("共通の始まり ");
    expect(wrapped.at(-1)).toBe(" 共通の終わり");
  });
});
