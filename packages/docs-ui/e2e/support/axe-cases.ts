import { SCREEN_IDS, readCheckConfig } from "./gallery";

/** axe を当てる幅。デスクトップ（1440）とスマホ（390）。320 / 375 は横スクロールの検査（overflow.spec.ts）が見る。 */
export const AXE_WIDTHS = [1440, 390] as const;

export type AxeCase = { screen: string; width: number };

/**
 * axe を当てる (画面, 幅) の一覧。
 * - 画面: `gallery/screens.ts` の全画面
 * - 状態違い: `gallery/check.tsx` の VARIANTS（公開のシート・設定系ページ・レールや一覧を開いた状態）。
 *   VARIANTS が持つ幅のうち、AXE_WIDTHS に含まれるものだけ（スマホ専用の状態違いをデスクトップで重ねて数えない）。
 */
export function axeCases(): AxeCase[] {
  const { variants } = readCheckConfig();
  const cases: AxeCase[] = [
    ...SCREEN_IDS.flatMap((screen) => AXE_WIDTHS.map((width) => ({ screen, width }))),
    ...variants.flatMap((variant) =>
      AXE_WIDTHS.filter((width) => variant.widths.includes(width)).map((width) => ({ screen: variant.id, width })),
    ),
  ];
  const keys = cases.map((entry) => `${entry.screen}@${entry.width}`);
  const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicated.length > 0) throw new Error(`axe の検査対象が重複しています: ${[...new Set(duplicated)].join(", ")}`);
  return cases;
}
