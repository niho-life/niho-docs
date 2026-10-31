import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { openScreen } from "./support/gallery";

// 録音の文字起こし（ShellRecording）の、操作したあとの状態を実ブラウザで確かめる（Issue #36 段 3a）。
// gallery の既定の状態は axe.spec.ts・overflow.spec.ts が見る。ここは、押さないと出ない部分（話者の名前のフォーム・まとめる確認）と、
// 段落をその場で直す操作（contenteditable の確定・取り消し）を見る。
const WIDTHS = [1440, 390, 375, 320] as const;
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const SCREEN = "page:rec?speakers=3&rail=0";

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.flat().join(" ")).join(" | ")}`);
}

const horizontalOverflow = (page: Page): Promise<number> =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));

for (const width of WIDTHS) {
  test(`話者の名前のフォームとまとめる確認 @${width}px: 横スクロールも axe の serious 以上も無い`, async ({ page }) => {
    await openScreen(page, SCREEN, width);
    await page.getByRole("button", { name: "Takuya の名前を変える" }).click();
    const form = page.locator(".es-spkform");
    await expect(form).toBeVisible();
    await expect(form.getByRole("textbox", { name: "Takuya の新しい名前" })).toBeFocused();
    expect(await horizontalOverflow(page), "名前のフォーム").toBe(0);
    expect(await seriousViolations(page), "名前のフォーム").toEqual([]);

    await form.getByRole("button", { name: "まとめる", exact: true }).click();
    await expect(form.getByText("元には戻せません。")).toBeVisible();
    expect(await horizontalOverflow(page), "まとめる確認").toBe(0);
    expect(await seriousViolations(page), "まとめる確認").toEqual([]);

    // 失敗の理由（「話者1」の形は使えない）も、はみ出さず、読み上げられる
    await form.locator(".es-spkform-merge").getByRole("button", { name: "やめる" }).click();
    const input = form.getByRole("textbox");
    await input.fill("話者1");
    await form.getByRole("button", { name: "決める" }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect(await horizontalOverflow(page), "名前の失敗").toBe(0);
    expect(await seriousViolations(page), "名前の失敗").toEqual([]);
  });
}

test("話者の名前を決めると、全段落の名前が替わり、Esc でやめるとフォーカスが話者に戻る", async ({ page }) => {
  await openScreen(page, SCREEN, 1440);
  await page.getByRole("button", { name: "Mika の名前を変える" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".es-spkform")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mika の名前を変える" })).toBeFocused();

  await page.getByRole("button", { name: "Mika の名前を変える" }).click();
  await page.getByRole("textbox", { name: "Mika の新しい名前" }).fill("Mika Sato");
  await page.keyboard.press("Enter");
  await expect(page.locator(".es-spkform")).toHaveCount(0);
  await expect(page.locator(".es-who span", { hasText: "Mika Sato" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Mika Sato の名前を変える" })).toBeFocused();
});

test("段落を直して Enter で確定、Esc で取り消し。時刻の切り替えは段落の文章を変えない", async ({ page }) => {
  await openScreen(page, "page:rec?rail=0", 1440);
  const paragraph = page.getByRole("textbox", { name: /^Mika 00:41 の文字起こし$/ });
  const original = (await paragraph.textContent()) ?? "";
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("（追記）");
  await page.keyboard.press("Enter");
  await expect(paragraph).not.toBeFocused();
  await expect(paragraph).toHaveText(`${original}（追記）`);

  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type("やめる");
  await page.keyboard.press("Escape");
  await expect(paragraph).toHaveText(`${original}（追記）`);

  const timestamps = page.getByRole("button", { name: "タイムスタンプ" });
  await expect(timestamps).toHaveAttribute("aria-pressed", "true");
  await timestamps.click();
  await expect(timestamps).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".es-who time")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Mika の文字起こし" })).toHaveText(`${original}（追記）`);
});
