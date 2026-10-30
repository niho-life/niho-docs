import { expect, test } from "@playwright/test";

import { SCREEN_IDS, VIEWPORT_HEIGHT, readCheckConfig } from "./support/gallery";

// gallery の `#/_check` が、全画面 × 幅を iframe で順に開いて測った結果（window.__overflowReport）を読み、
// 横スクロール（documentElement の scrollWidth > clientWidth）と、画面の中で横に出ている要素（意図した `data-hscroll` を除く）が
// 1 件も無いことを確かめる（Issue #43: 320px・375px で横スクロールなし）。許容リストは使わない。

type Row = { id: string; width: number; scrollWidth: number; clientWidth: number; overflow: number; inner: number };
type CheckWindow = { __overflowReport?: Row[]; __overflowDone?: boolean };

/** Issue #43 の受入に出てくる幅。#_check がこれらを全部測っていること自体も確かめる。 */
const REQUIRED_WIDTHS = [1440, 390, 375, 320];

function describeRow(row: Row): string {
  if (row.overflow < 0 || row.inner < 0) return `${row.id} @${row.width}px: 画面が描画されず、測れませんでした`;
  const parts: string[] = [];
  if (row.overflow !== 0) parts.push(`横スクロール ${row.overflow}px（scrollWidth ${row.scrollWidth} > clientWidth ${row.clientWidth}）`);
  if (row.inner !== 0) parts.push(`画面の外に出ている要素 ${row.inner} 件`);
  return `${row.id} @${row.width}px: ${parts.join("、")}`;
}

test("横スクロールが無い（全画面 × 1440 / 390 / 375 / 320）", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: VIEWPORT_HEIGHT });
  await page.goto("/#/_check");
  await page.waitForFunction(() => (window as unknown as CheckWindow).__overflowDone === true, undefined, { timeout: 240_000 });
  const report = await page.evaluate(() => (window as unknown as CheckWindow).__overflowReport ?? []);

  // 測った画面・幅が、gallery が測るはずの一覧と一致する（行が欠けたり、0 件で素通りしたりしない）
  const { widths, variants } = readCheckConfig();
  const expectedKeys = [
    ...SCREEN_IDS.flatMap((id) => widths.map((width) => `${id}@${width}`)),
    ...variants.flatMap((variant) => variant.widths.map((width) => `${variant.id}@${width}`)),
  ].sort();
  expect(report.map((row) => `${row.id}@${row.width}`).sort(), "#_check の測定結果が、画面 × 幅の一覧と一致しません").toEqual(expectedKeys);
  for (const width of REQUIRED_WIDTHS) {
    expect(new Set(report.map((row) => row.width)), `幅 ${width}px が #_check の検査に含まれていません`).toContain(width);
  }

  const bad = report.filter((row) => row.overflow !== 0 || row.inner !== 0).map(describeRow);
  expect(bad, `横にはみ出した画面があります（${bad.length} 件 / ${report.length} 件）`).toEqual([]);
});
