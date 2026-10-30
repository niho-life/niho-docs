import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { axeCases } from "./support/axe-cases";
import { openScreen } from "./support/gallery";
import { diffRules, entryKey, loadKnown, writeActual, type FoundViolation } from "./support/known";

// gallery の各画面に axe を当て、serious 以上の違反を「許容リスト（known-violations.json）」と突き合わせる（Issue #43）。
// - 許容リストに無い違反が出たら落ちる（新しい違反を持ち込まない）。
// - 許容リストにあるのに出なくなったら、これも落ちる（直ったので、行を消してリストを新しくする）。
// 違反を直すたびにリストが縮み、悪化は CI で止まる。受入は「リストが空になること」。
// リストの更新: UPDATE_KNOWN=1 npx playwright test e2e/axe.spec.ts

/** axe に見せる規則の範囲。WCAG 2.0 / 2.1 の A・AA。best-practice（heading-order・region など）は含めない。 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const UPDATE = Boolean(process.env.UPDATE_KNOWN);

async function analyze(page: Page): Promise<FoundViolation[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const found: FoundViolation[] = [];
  for (const violation of results.violations) {
    if (violation.impact !== "serious" && violation.impact !== "critical") continue;
    found.push({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      selectors: violation.nodes.slice(0, 3).map((node) => node.target.flat().join(" ")),
    });
  }
  return found.sort((a, b) => a.rule.localeCompare(b.rule, "en"));
}

const describeViolation = (violation: FoundViolation): string =>
  `  - ${violation.rule}（${violation.impact}）${violation.nodes} 件: ${violation.help}\n      ${violation.selectors.join("\n      ")}`;

const cases = axeCases();

test.describe("axe（serious 以上）", () => {
  // 許容リストは読み込み時に 1 度だけ。書式の誤りはここで落ちる（どのテストも走らない）
  const known = loadKnown();

  test("許容リストの画面・幅は、すべて検査対象にある", () => {
    const targets = new Set(cases.map((entry) => `${entry.screen}@${entry.width}`));
    const orphans = known.filter((entry) => !targets.has(`${entry.screen}@${entry.width}`)).map(entryKey);
    expect(orphans, "known-violations.json に、検査対象に無い画面・幅の行が残っています。消してください").toEqual([]);
  });

  for (const { screen, width } of cases) {
    test(`${screen} @${width}px`, async ({ page }) => {
      await openScreen(page, screen, width);
      const found = await analyze(page);

      if (UPDATE) {
        writeActual({ screen, width, violations: found });
        return;
      }

      const expected = new Set(known.filter((entry) => entry.screen === screen && entry.width === width).map((entry) => entry.rule));
      const { added, fixed } = diffRules(expected, found);
      const lines: string[] = [];
      if (added.length > 0) {
        lines.push("許容リストに無い新しい違反（直してください。許容リストに足してはいけません）:", ...added.map(describeViolation));
      }
      if (fixed.length > 0) {
        lines.push(
          "許容リストにあるのに出なくなった違反（直りました。e2e/known-violations.json から消してください。UPDATE_KNOWN=1 で更新できます）:",
          ...fixed.map((rule) => `  - ${rule}`),
        );
      }
      if (lines.length > 0) throw new Error(`${screen} @${width}px\n${lines.join("\n")}`);
    });
  }
});
