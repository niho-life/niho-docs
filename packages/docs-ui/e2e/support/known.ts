import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AXE_ACTUAL_DIR, KNOWN_VIOLATIONS_PATH } from "./paths";

/** 許容リストの対象にする重大度。これ未満（moderate・minor）は検査しない。 */
export type Impact = "serious" | "critical";

/** 許容リストの 1 行。「この画面・この幅で、この規則の違反が、いまある」。 */
export type KnownEntry = {
  screen: string;
  width: number;
  rule: string;
  impact: Impact;
  /** なぜいま許容しているか（短い日本語）。直したら行ごと消す。 */
  reason: string;
  /** 直す Issue。 */
  issue: string;
};

/** axe が返した違反を、検査に必要な分だけ縮めたもの。 */
export type FoundViolation = {
  rule: string;
  impact: Impact;
  /** axe の説明（英語）。失敗時のメッセージ用。 */
  help: string;
  /** 違反の要素の数。 */
  nodes: number;
  /** 最初の 3 つのセレクタ。 */
  selectors: string[];
};

export type ActualRecord = { screen: string; width: number; violations: FoundViolation[] };

export const NOTE =
  "axe（serious 以上）の違反の「いまの状態」。(screen, width, rule) の集合が実行結果と一致しないと e2e/axe.spec.ts が落ちる" +
  "（新しい違反も、直った違反も）。直したら該当の行を消す。足してはいけない（新しい違反は直す）。更新は UPDATE_KNOWN=1 npx playwright test e2e/axe.spec.ts。";

/** 規則ごとの既定の理由。生成のとき、既存の行の reason が無い規則にだけ使う。 */
const REASONS: Record<string, string> = {
  "color-contrast": "補助文字の色（--ed-ink-mute の #8e8e86 ほか）が背景に対して AA の 4.5:1 に届かない。色の見直しは別 PR",
  "label-content-name-mismatch": "ボタンの aria-label が、見えている文字（「テキスト ▾」など）を含まない。ラベルの付け方の修正は別 PR",
  "nested-interactive": "カバー（role=img）の中に「変更」ボタンがある。役割の分け直しは別 PR",
};
const FALLBACK_REASON = "原因の調査と修正は別 PR";

export function defaultReason(rule: string): string {
  return REASONS[rule] ?? FALLBACK_REASON;
}

export const entryKey = (entry: { screen: string; width: number; rule: string }): string => `${entry.screen}@${entry.width}#${entry.rule}`;

function assertEntry(value: unknown, index: number): KnownEntry {
  const where = `known-violations.json の ${index + 1} 件目`;
  if (typeof value !== "object" || value === null) throw new Error(`${where} がオブジェクトではありません`);
  const entry = value as Record<string, unknown>;
  const { screen, width, rule, impact, reason, issue } = entry;
  if (typeof screen !== "string" || screen === "") throw new Error(`${where}: screen がありません`);
  if (typeof width !== "number" || !Number.isInteger(width)) throw new Error(`${where}: width が整数ではありません`);
  if (typeof rule !== "string" || rule === "") throw new Error(`${where}: rule がありません`);
  if (impact !== "serious" && impact !== "critical") throw new Error(`${where}: impact は serious か critical です`);
  if (typeof reason !== "string" || reason.trim() === "") throw new Error(`${where}: reason（理由）がありません`);
  if (typeof issue !== "string" || !/^#\d+$/.test(issue)) throw new Error(`${where}: issue は "#43" の形で書きます`);
  return { screen, width, rule, impact, reason, issue };
}

export function loadKnown(file: string = KNOWN_VIOLATIONS_PATH): KnownEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new Error("known-violations.json に entries（配列）がありません");
  const result = entries.map((entry, index) => assertEntry(entry, index));
  const keys = result.map(entryKey);
  const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicated.length > 0) throw new Error(`known-violations.json に同じ行が 2 つあります: ${[...new Set(duplicated)].join(", ")}`);
  return result;
}

/** 1 行 1 件で書く（差分で何が増減したか読めるように）。 */
export function saveKnown(entries: readonly KnownEntry[], file: string = KNOWN_VIOLATIONS_PATH): void {
  const lines = entries.map((entry) => `    ${JSON.stringify(entry)}`);
  const text = `{\n  "note": ${JSON.stringify(NOTE)},\n  "entries": [\n${lines.join(",\n")}\n  ]\n}\n`;
  writeFileSync(file, text, "utf8");
}

export function writeActual(record: ActualRecord): void {
  mkdirSync(AXE_ACTUAL_DIR, { recursive: true });
  const name = createHash("sha1").update(`${record.screen}@${record.width}`).digest("hex");
  writeFileSync(path.join(AXE_ACTUAL_DIR, `${name}.json`), JSON.stringify(record), "utf8");
}

export function readActual(): ActualRecord[] {
  let names: string[];
  try {
    names = readdirSync(AXE_ACTUAL_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => JSON.parse(readFileSync(path.join(AXE_ACTUAL_DIR, name), "utf8")) as ActualRecord);
}

/** 実行結果（違反の規則の集合）と許容リストの突き合わせ。 */
export function diffRules(expected: ReadonlySet<string>, found: readonly FoundViolation[]): { added: FoundViolation[]; fixed: string[] } {
  const foundRules = new Set(found.map((violation) => violation.rule));
  return {
    added: found.filter((violation) => !expected.has(violation.rule)),
    fixed: [...expected].filter((rule) => !foundRules.has(rule)).sort(),
  };
}
