import { describe, expect, it } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import { arrangeSidebarItems, formatWhen, searchPages } from "./sidebar-items";

/** 2026-10-31 12:00（東京）＝ 03:00 UTC。 */
const NOW = Date.parse("2026-10-31T03:00:00.000Z");

function page(id: string, over: Partial<PageSummary> = {}): PageSummary {
  return { id, kind: "note", title: id, lang: "ja", parent: null, stepStatus: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-31T02:00:00.000Z", ...over };
}

describe("formatWhen", () => {
  const at = (iso: string) => formatWhen(iso, NOW);

  it("counts minutes and hours within the same Tokyo day", () => {
    expect(at("2026-10-31T03:00:00.000Z")).toBe("たった今");
    expect(at("2026-10-31T02:59:01.000Z")).toBe("たった今");
    expect(at("2026-10-31T03:05:00.000Z")).toBe("たった今");
    expect(at("2026-10-31T02:59:00.000Z")).toBe("1分前");
    expect(at("2026-10-31T02:00:01.000Z")).toBe("59分前");
    expect(at("2026-10-31T02:00:00.000Z")).toBe("1時間前");
    // 東京の 0:00（＝前の日の 15:00 UTC）はまだ同じ日
    expect(at("2026-10-30T15:00:00.000Z")).toBe("12時間前");
  });

  it("uses Tokyo calendar days for 昨日 and N日前, not 24-hour periods", () => {
    expect(at("2026-10-30T14:59:59.000Z")).toBe("昨日");
    expect(at("2026-10-29T15:00:00.000Z")).toBe("昨日");
    expect(at("2026-10-29T14:59:59.000Z")).toBe("2日前");
    expect(at("2026-10-24T15:00:00.000Z")).toBe("6日前");
    expect(at("2026-10-24T14:59:59.000Z")).toBe("10月24日");
  });

  it("shows the month and day in the same Tokyo year and adds the year before that", () => {
    expect(at("2026-01-01T00:00:00.000Z")).toBe("1月1日");
    // 2025-12-31 15:00 UTC は東京では 2026-01-01
    expect(at("2025-12-31T15:00:00.000Z")).toBe("1月1日");
    expect(at("2025-12-31T14:59:59.000Z")).toBe("2025年12月31日");
    expect(at("2019-05-03T00:00:00.000Z")).toBe("2019年5月3日");
    expect(at("not a date")).toBe("");
  });

  it("is a pure function of now (the first browser render matches the server)", () => {
    const iso = "2026-10-31T01:00:00.000Z";
    expect(formatWhen(iso, NOW)).toBe(formatWhen(iso, NOW));
    expect(formatWhen(iso, NOW + 60 * 60 * 1000)).toBe("3時間前");
  });
});

describe("arrangeSidebarItems", () => {
  it("keeps update order at the top level and puts loaded descendants under their top ancestor in creation order", () => {
    const pages = [
      page("step-2", { parent: "rec", kind: "step", createdAt: "2026-10-02T00:00:00.000Z", stepStatus: "run" }),
      page("note"),
      page("rec", { kind: "rec" }),
      page("step-3", { parent: "step-2", kind: "step", createdAt: "2026-10-03T00:00:00.000Z" }),
      page("step-1", { parent: "rec", kind: "step", createdAt: "2026-10-01T00:00:00.000Z", stepStatus: "done" }),
      page("orphan", { parent: "not-loaded", kind: "step" }),
    ];
    const items = arrangeSidebarItems(pages, { now: NOW });
    expect(items.map((item) => [item.id, item.child ?? false])).toEqual([
      ["note", false],
      ["rec", false],
      ["step-1", true],
      ["step-2", true],
      ["step-3", true],
      ["orphan", false],
    ]);
  });

  it("shows the second line only for recordings and steps in progress", () => {
    const items = arrangeSidebarItems(
      [page("rec", { kind: "rec" }), page("run", { stepStatus: "run" }), page("done", { stepStatus: "done" }), page("plain", { title: "" })],
      { now: NOW },
    );
    expect(items.map((item) => item.sub)).toEqual([{ text: "録音" }, { text: "作成中…" }, undefined, undefined]);
    expect(items[3]).toEqual({ id: "plain", title: "", when: "1時間前" });
  });

  it("never drops rows whose parents form a cycle", () => {
    const items = arrangeSidebarItems([page("a", { parent: "b" }), page("b", { parent: "a" })], { now: NOW });
    expect(items.map((item) => [item.id, item.child ?? false])).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("filters by title (NFKC, case-insensitive) and lists matches flat", () => {
    const pages = [page("rec", { title: "ＮＩＨＯ Kamakura 録音" }), page("child", { parent: "rec", title: "niho の手順" }), page("other", { title: "日記" })];
    const items = arrangeSidebarItems(pages, { now: NOW, query: " niho " });
    expect(items.map((item) => [item.id, item.child ?? false])).toEqual([
      ["rec", false],
      ["child", false],
    ]);
    expect(arrangeSidebarItems(pages, { now: NOW, query: "   " })).toHaveLength(3);
    expect(searchPages(pages, "ｶﾏｸﾗ")).toEqual([]);
    expect(searchPages(pages, "KAMAKURA").map((item) => item.id)).toEqual(["rec"]);
  });
});

describe("arrangeSidebarItems: 2 行目の公開先（#39）", () => {
  const live = { dest: "exp", handle: "exp", range: "live", stopped: false } as const;

  it("公開中は発信先の名前と印。限定公開も同じ。本人のサイトは「自分のサイト」", () => {
    const rows = arrangeSidebarItems(
      [
        { ...page("a"), publication: live },
        { ...page("b"), publication: { dest: "niho", handle: "niho", range: "unlisted", stopped: false } },
        { ...page("c"), publication: { dest: "site", handle: "field-notes", range: "live", stopped: false } },
      ],
      { now: NOW },
    );
    expect(rows.map((row) => row.sub)).toEqual([
      { text: "NIHO Experience", dest: "exp" },
      { text: "NIHO", dest: "niho" },
      { text: "自分のサイト", dest: "site" },
    ]);
  });

  it("公開をやめたページは「公開をやめた」（印なし）。公開の無いページは今までどおり", () => {
    const rows = arrangeSidebarItems(
      [{ ...page("a"), publication: { ...live, stopped: true } }, { ...page("b", { kind: "rec" }), publication: null }, page("c")],
      { now: NOW },
    );
    expect(rows.map((row) => row.sub)).toEqual([{ text: "公開をやめた" }, { text: "録音" }, undefined]);
  });

  it("公開中は録音・作成中より先に出す（モック v6 の順）。検索の結果でも同じ", () => {
    const rec = { ...page("rec", { kind: "rec", title: "鎌倉の録音" }), publication: live };
    expect(arrangeSidebarItems([rec], { now: NOW })[0]!.sub).toEqual({ text: "NIHO Experience", dest: "exp" });
    expect(arrangeSidebarItems([rec], { now: NOW, query: "鎌倉" })[0]!.sub).toEqual({ text: "NIHO Experience", dest: "exp" });
  });
});
