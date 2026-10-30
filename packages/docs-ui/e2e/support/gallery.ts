import { readFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { SCREENS } from "../../gallery/screens";
import { GALLERY_DIR } from "./paths";

/** gallery の `#/_check` と同じ高さ。画面の高さが変わると、はみ出し・axe の結果も変わりうるので固定する。 */
export const VIEWPORT_HEIGHT = 900;

/** gallery の画面（`gallery/screens.ts` の SCREENS）。 */
export const SCREEN_IDS: readonly string[] = SCREENS.map((screen) => screen.id);

export type Variant = { id: string; widths: readonly number[] };

/**
 * `gallery/check.tsx` の CHECK_WIDTHS と VARIANTS（状態違いの画面）を、ソースを読んで取り出す。
 * 画面の一覧を e2e 側に二重に持たず、gallery の `#/_check` と同じ画面を検査するため。
 * check.tsx の書き方が変わって読めなくなったら、黙って 0 件にせず、ここで失敗させる。
 */
export function readCheckConfig(): { widths: readonly number[]; variants: readonly Variant[] } {
  const source = readFileSync(path.join(GALLERY_DIR, "check.tsx"), "utf8");
  const widthsText = /export const CHECK_WIDTHS = \[([^\]]*)\] as const/.exec(source)?.[1];
  const variantsText = /const VARIANTS\b[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source)?.[1];
  if (widthsText === undefined || variantsText === undefined) {
    throw new Error("gallery/check.tsx から CHECK_WIDTHS / VARIANTS を読めません。e2e/support/gallery.ts の読み方を直してください。");
  }
  const toWidths = (text: string): number[] => text.split(",").map((part) => Number(part.trim()));
  const widths = toWidths(widthsText);
  const variants = [...variantsText.matchAll(/\{\s*id:\s*"([^"]+)",\s*widths:\s*\[([^\]]*)\]\s*\}/g)].map((match) => ({
    id: match[1] ?? "",
    widths: toWidths(match[2] ?? ""),
  }));
  const declared = variantsText.match(/\bid:/g)?.length ?? 0;
  const bad = [...widths, ...variants.flatMap((variant) => variant.widths)].some((width) => !Number.isInteger(width) || width <= 0);
  if (variants.length === 0 || variants.length !== declared || bad) {
    throw new Error(`gallery/check.tsx の VARIANTS を読み切れません（読めた ${variants.length} 件 / 宣言 ${declared} 件）。`);
  }
  return { widths, variants };
}

/** 動き（transition・animation）を止める。途中の色で axe やはみ出しを測らないため。 */
const FREEZE_MOTION_CSS = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

const nextFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

/**
 * gallery の画面単体を、指定の幅で開き、描画が終わるまで待つ。
 * 待つのは条件だけ: 画面の root（`.es-root`）が表示される → フォントの読み込みが終わる → 描画が 2 フレーム進む。
 * 固定の待ち時間は使わない。画面の状態（シート・レール・一覧）は id に含まれる（`page:kita?rail=1` など）。
 * 幅は matchMedia で初期状態が決まるので、必ず開く前に決める。
 */
export async function openScreen(page: Page, id: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.goto(`/#/${id}`);
  await page.locator(".es-root").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await nextFrames(page);
  await page.addStyleTag({ content: FREEZE_MOTION_CSS });
  await nextFrames(page);
}
