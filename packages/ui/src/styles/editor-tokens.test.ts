import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const editor = read("editor-tokens.css");
const base = read("tokens.css");

const declared = (css: string) =>
  new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as const));

describe("editor-tokens.css", () => {
  const tokens = declared(editor);

  it("モック v6 の中立色を #48 の値のまま持つ", () => {
    expect(tokens.get("--ed-ink")).toBe("#2a2a26");
    expect(tokens.get("--ed-ink-sub")).toBe("#54544d");
    expect(tokens.get("--ed-ink-mute")).toBe("#8e8e86");
    expect(tokens.get("--ed-canvas")).toBe("#fffdfa");
    expect(tokens.get("--ed-line")).toBe("#f1f1ed");
    expect(tokens.get("--ed-track")).toBe("#f2efe8");
    expect(tokens.get("--ed-accent-ink")).toBe("#56751e");
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
    const baseTokens = declared(base);
    const refs = [...editor.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    for (const ref of refs) expect(baseTokens.has(ref), ref).toBe(true);
    for (const name of tokens.keys()) expect(name.startsWith("--ed-"), name).toBe(true);
  });
});
