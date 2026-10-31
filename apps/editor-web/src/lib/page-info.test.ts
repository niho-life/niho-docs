import { describe, expect, it } from "vitest";
import { countLabel, countText, formatDay, formatDuration, pageInfoRows } from "./page-info";

describe("page info (the ページ rows of the info panel)", () => {
  it("counts characters without spaces and line breaks, and words separated by spaces", () => {
    expect(countText("")).toEqual({ chars: 0, words: 0 });
    expect(countText("合成の 本文\nです")).toEqual({ chars: 7, words: 3 });
    expect(countText("  A synthetic   body\n\ntext. ")).toEqual({ chars: 19, words: 4 });
    // サロゲートペアは 1 文字
    expect(countText("𠮷野家")).toEqual({ chars: 3, words: 1 });
  });

  it("says characters for a Japanese page and words for an English one (as the mock v6)", () => {
    expect(countLabel({ chars: 412, words: 3 }, "ja")).toBe("412");
    expect(countLabel({ chars: 1234, words: 3 }, "ja")).toBe("1,234");
    expect(countLabel({ chars: 9000, words: 1180 }, "en")).toBe("1,180 words");
    expect(countLabel({ chars: 4, words: 1 }, "en")).toBe("1 word");
    expect(countLabel({ chars: 0, words: 0 }, "en")).toBe("0 words");
  });

  it("formats the day on this device (YYYY-MM-DD) and a recording length (m:ss, h:mm:ss)", () => {
    expect(formatDay(new Date(2026, 9, 28, 23, 30).toISOString())).toBe("2026-10-28");
    expect(formatDay(new Date(2026, 0, 2, 0, 5).toISOString())).toBe("2026-01-02");
    expect(formatDay("not a time")).toBe("");
    expect(formatDuration(878)).toBe("14:38");
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("lists 作成・更新・録音 (only a recording with a known length)・文字数 (only once counted)", () => {
    const createdAt = new Date(2026, 9, 28, 9).toISOString();
    const updatedAt = new Date(2026, 9, 30, 18).toISOString();
    const base = { kind: "note" as const, lang: "ja" as const, createdAt, updatedAt, recordingSec: null, counts: { chars: 412, words: 9 } };
    expect(pageInfoRows(base)).toEqual([
      { label: "作成", value: "2026-10-28" },
      { label: "更新", value: "2026-10-30" },
      { label: "文字数", value: "412" },
    ]);
    expect(pageInfoRows({ ...base, kind: "rec", recordingSec: 878, lang: "en" })).toEqual([
      { label: "作成", value: "2026-10-28" },
      { label: "更新", value: "2026-10-30" },
      { label: "録音", value: "14:38" },
      { label: "文字数", value: "9 words" },
    ]);
    // 録音の長さが分からない・録音ページでない・まだ数えていない
    expect(pageInfoRows({ ...base, kind: "rec", recordingSec: null }).map((row) => row.label)).toEqual(["作成", "更新", "文字数"]);
    expect(pageInfoRows({ ...base, kind: "note", recordingSec: 878 }).map((row) => row.label)).toEqual(["作成", "更新", "文字数"]);
    expect(pageInfoRows({ ...base, counts: null }).map((row) => row.label)).toEqual(["作成", "更新"]);
  });
});
