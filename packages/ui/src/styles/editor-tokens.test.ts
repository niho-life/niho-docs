import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const editor = read("editor-tokens.css");
const base = read("tokens.css");

const declared = (css: string) =>
  new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as const));

/* ───── WCAG 2.x のコントラスト比（依存を増やさず、ここで計算する） ───── */

/** #rgb / #rrggbb を 0〜1 の RGB にする。 */
function rgb(hex: string): [number, number, number] {
  const raw = hex.replace(/^#/, "");
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`hex ではない色: ${hex}`);
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
}

/** 相対輝度（WCAG 2.x の定義。sRGB の 0.04045 で分ける）。 */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** コントラスト比（1〜21）。 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast()（WCAG の計算そのもの）", () => {
  it("白と黒は 21:1、同じ色は 1:1、順番によらない", () => {
    expect(contrast("#fff", "#000")).toBeCloseTo(21, 5);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("よく知られた値と合う（#767676 は白で 4.54:1、#777777 は 4.48:1）", () => {
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

describe("editor-tokens.css", () => {
  const tokens = declared(editor);
  const baseTokens = declared(base);

  /** --ed-* を hex まで解く（var(--niho-*) は tokens.css の値を引く）。 */
  const resolve = (name: string): string => {
    const value = tokens.get(name) ?? baseTokens.get(name);
    if (value === undefined) throw new Error(`${name} がありません`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    return ref ? resolve(ref) : value.toLowerCase();
  };

  it("モック v6 の中立色を持つ（--ed-ink-mute・--ed-ink-faint だけは #43 で AA に合わせて暗くした）", () => {
    expect(tokens.get("--ed-ink")).toBe("#2a2a26");
    expect(tokens.get("--ed-ink-sub")).toBe("#54544d");
    // #48 のモック値 #8e8e86（白で 3.3:1）→ 4.5:1 を満たす値へ（#43）
    expect(tokens.get("--ed-ink-mute")).toBe("#6e6d66");
    // #48 のモック値 #bdbdb7（白で 1.9:1）→ 非テキストの 3:1 を満たす値へ（#43）。文字には使わない
    expect(tokens.get("--ed-ink-faint")).toBe("#898880");
    expect(tokens.get("--ed-canvas")).toBe("#fffdfa");
    expect(tokens.get("--ed-line")).toBe("#f1f1ed");
    expect(tokens.get("--ed-track")).toBe("#f2efe8");
    expect(tokens.get("--ed-accent-ink")).toBe("#56751e");
  });

  it("橙の文字は --ed-amber-ink（--niho-orange は変えず、面・点の --ed-amber もそのまま）", () => {
    expect(tokens.get("--ed-amber")).toBe("var(--niho-orange)");
    expect(tokens.get("--ed-amber-soft")).toBe("var(--niho-orange-pale)");
    expect(tokens.get("--ed-amber-ink")).toBe("#a55827");
    expect(baseTokens.get("--niho-orange")?.toLowerCase()).toBe("#c8713a");
  });

  it("主ボタンと淡色面は既存の --niho-* を引き、値を写さない", () => {
    expect(tokens.get("--ed-primary-bg")).toBe("var(--niho-primary-bg)");
    expect(tokens.get("--ed-primary-bg-hover")).toBe("var(--niho-primary-bg-hover)");
    expect(tokens.get("--ed-primary-ink")).toBe("var(--niho-primary-ink)");
    expect(tokens.get("--ed-accent-soft")).toBe("var(--niho-accent-soft)");
  });

  it("緑の生 hex を増やしていない（持つ緑は --ed-accent-ink の #56751e だけ）", () => {
    const greens = ["#7dba3a", "#63a109", "#b2d67c", "#eef6e1", "#74b033", "#5c9508", "#4b9e5e", "#46811f"];
    const hexes = [...editor.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
    expect(hexes.filter((h) => greens.includes(h))).toEqual([]);
    expect(hexes).toContain("#56751e");
  });

  it("参照する --niho-* が tokens.css に実在し、既存の --niho-* を上書きしない", () => {
    const refs = [...editor.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    for (const ref of refs) expect(baseTokens.has(ref), ref).toBe(true);
    for (const name of tokens.keys()) expect(name.startsWith("--ed-"), name).toBe(true);
  });

  /* ───── コントラスト（WCAG AA。#43） ───── */

  /** 文字に使う token。 */
  const TEXT = ["--ed-ink", "--ed-ink-sub", "--ed-ink-mute", "--ed-accent-ink", "--ed-amber-ink", "--ed-track-ink"];
  /**
   * 文字が載る淡い面の token。いま文字が載っていない組み合わせ（track の上の ink-mute など）も含めて、
   * どの文字の token をどの面に載せても AA になるようにしておく（面と文字の組み合わせを、画面ごとに覚えなくてよいように）。
   */
  const SURFACES = [
    "--ed-white",
    "--ed-canvas",
    "--ed-shell",
    "--ed-sand",
    "--ed-sand-2",
    "--ed-accent-soft",
    "--ed-track",
    "--ed-amber-soft",
    "--ed-red-soft",
  ];

  it("文字の token は、どの面の token の上でも 4.5:1 以上（WCAG AA・通常の文字）", () => {
    const failures: string[] = [];
    for (const ink of TEXT) {
      for (const surface of SURFACES) {
        const ratio = contrast(resolve(ink), resolve(surface));
        if (ratio < 4.5) failures.push(`${ink} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("役割色の文字と、その淡色面の組み合わせも 4.5:1 以上（消す文の赤・情報の青）", () => {
    expect(contrast(resolve("--ed-red"), resolve("--ed-red-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve("--ed-blue"), resolve("--ed-blue-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("--ed-ink-faint（装飾の矢印・アイコン）は、どの面の上でも非テキストの 3:1 以上", () => {
    for (const surface of SURFACES) {
      expect(contrast(resolve("--ed-ink-faint"), resolve(surface)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("--niho-orange（--ed-amber）は小さい文字に足りない（だから文字は --ed-amber-ink）", () => {
    // 回帰の目印: --ed-amber を文字に戻すと AA を割る、という前提をここで固定する
    expect(contrast(resolve("--ed-amber"), resolve("--ed-white"))).toBeLessThan(4.5);
    expect(contrast(resolve("--ed-amber-ink"), resolve("--ed-white"))).toBeGreaterThanOrEqual(4.5);
  });
});
