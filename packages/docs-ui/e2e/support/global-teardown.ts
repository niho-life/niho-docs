import { existsSync } from "node:fs";

import { axeCases } from "./axe-cases";
import { defaultReason, entryKey, loadKnown, readActual, saveKnown, type KnownEntry } from "./known";
import { KNOWN_VIOLATIONS_PATH } from "./paths";

/**
 * `UPDATE_KNOWN=1` のとき、今回の実行結果で e2e/known-violations.json を作り直す。
 * - 実行した (画面, 幅) の行は、実行結果で置き換える。直った行は消え、新しい行は足される。
 *   既存の行の reason / issue は引き継ぐ。新しい行には規則ごとの既定の理由が入るので、必要なら直す。
 * - 実行しなかった (画面, 幅) の行はそのまま残す（`--grep` で一部だけ更新できる）。
 * - 検査対象に無くなった画面の行は捨てる。
 * UPDATE_KNOWN を付けない実行では何も書かない（CI は書き換えず、比べるだけ）。
 */
export default function globalTeardown(): void {
  if (!process.env.UPDATE_KNOWN) return;
  const actual = readActual();
  if (actual.length === 0) {
    console.log("[UPDATE_KNOWN] 実行結果が無いので、known-violations.json は変えません。");
    return;
  }

  const cases = axeCases();
  const order = new Map(cases.map((entry, index) => [`${entry.screen}@${entry.width}`, index]));
  const previous = existsSync(KNOWN_VIOLATIONS_PATH) ? loadKnown() : [];
  const previousByKey = new Map(previous.map((entry) => [entryKey(entry), entry]));
  const ran = new Set(actual.map((record) => `${record.screen}@${record.width}`));

  const kept = previous.filter((entry) => {
    const caseKey = `${entry.screen}@${entry.width}`;
    return order.has(caseKey) && !ran.has(caseKey);
  });
  const fresh = actual.flatMap((record): KnownEntry[] =>
    record.violations.map((violation) => {
      const old = previousByKey.get(entryKey({ screen: record.screen, width: record.width, rule: violation.rule }));
      return {
        screen: record.screen,
        width: record.width,
        rule: violation.rule,
        impact: violation.impact,
        reason: old?.reason ?? defaultReason(violation.rule),
        issue: old?.issue ?? "#43",
      };
    }),
  );

  const next = [...kept, ...fresh].sort(
    (a, b) =>
      (order.get(`${a.screen}@${a.width}`) ?? 0) - (order.get(`${b.screen}@${b.width}`) ?? 0) ||
      a.rule.localeCompare(b.rule, "en"),
  );
  saveKnown(next);

  const before = new Set(previous.map(entryKey));
  const after = new Set(next.map(entryKey));
  const added = [...after].filter((key) => !before.has(key)).length;
  const removed = [...before].filter((key) => !after.has(key)).length;
  console.log(`[UPDATE_KNOWN] known-violations.json を更新: ${next.length} 件（追加 ${added} / 削除 ${removed}）。差分を確認して commit してください。`);
}
