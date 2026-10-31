// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pgPublicApiSource } from "./pg-source";

/**
 * 一覧の SQL だけを受ける偽の DB。`LIMIT $3`（limit + 1 件）と、続きの位置（$4・$5）に従って、合成の行を新しい順に返す。
 * 実 DB の一覧の経路は pg-source.pg.test.ts（TEST_DATABASE_URL が要る）。ここは DB が無くても CI で必ず走る。
 */
const TOTAL = 150;
const pageId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const updatedAt = (index: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) - index * 60_000);
const cursorTime = (index: number) => `${updatedAt(index).toISOString().slice(0, -1)}000Z`;

function row(index: number) {
  return {
    page_id: pageId(index),
    dest: "exp",
    handle: "exp",
    slug: `page-${index}`,
    range: "live",
    extras_app: false,
    extras_news: false,
    extras_xp: false,
    category: null,
    related: [],
    version: 1,
    published_at: updatedAt(index),
    updated_at: updatedAt(index),
    stopped_at: null,
    listing: { title: `page ${index}` },
    cursor_time: cursorTime(index),
  };
}

function fakeDb() {
  const asked: number[] = [];
  return {
    asked,
    db: {
      async query(_sql: string, params: unknown[] = []) {
        const limit = Number(params[2]);
        asked.push(limit);
        // 位置（$4）は、そこより古い行から。新しい順に index が増える
        const start = typeof params[3] === "string" ? Array.from({ length: TOTAL }, (_, index) => index).findIndex((index) => cursorTime(index) === params[3] && pageId(index) === params[4]) + 1 : 0;
        return { rows: Array.from({ length: TOTAL }, (_, index) => row(index)).slice(start, start + limit) };
      },
    },
  };
}

describe("pgPublicApiSource.listPublished", () => {
  it("最大の件数（limit + 1 = 101）を頼まれたら、store の上限（100）で切れても、続きがあれば先読みの 1 行まで返す", async () => {
    const { db, asked } = fakeDb();
    const source = pgPublicApiSource(db as never, { assetUrls: () => null } as never);
    const rows = await source.listPublished({ handle: "exp", includeUnlisted: false, after: null, limit: 101, now: "2026-10-01T00:00:00.000Z" });
    expect(rows).toHaveLength(101);
    // 100 件 + 続きの先読み 1 件（store の limit は 100 に切られ、その中の先読みは 101 行目として返らない）
    expect(asked).toEqual([101, 2]);
    expect(rows.map((item) => (item.snapshot as unknown as { title: string }).title).slice(98, 101)).toEqual(["page 98", "page 99", "page 100"]);
  });

  it("続きが無ければ、あるだけ返す（先読みは足さない）", async () => {
    const { db } = fakeDb();
    const source = pgPublicApiSource(db as never, { assetUrls: () => null } as never);
    const rows = await source.listPublished({
      handle: "exp",
      includeUnlisted: false,
      after: { updatedAt: updatedAt(139).toISOString(), id: pageId(139) },
      limit: 101,
      now: "2026-10-01T00:00:00.000Z",
    });
    expect(rows).toHaveLength(10);
  });

  it("上限より小さい limit は 1 回で済む", async () => {
    const { db, asked } = fakeDb();
    const source = pgPublicApiSource(db as never, { assetUrls: () => null } as never);
    const rows = await source.listPublished({ handle: "exp", includeUnlisted: false, after: null, limit: 51, now: "2026-10-01T00:00:00.000Z" });
    expect(rows).toHaveLength(51);
    expect(asked).toHaveLength(1);
  });
});
