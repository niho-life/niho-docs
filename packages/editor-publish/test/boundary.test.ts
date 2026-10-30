/** Package boundaries: production code depends on the contract only and never on test-only code. */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = readdirSync(`${root}src`).filter((name) => name.endsWith(".ts"));

function specifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1] ?? match[2] ?? "");
}

describe("boundaries", () => {
  it.each(sources)("src/%s imports only the contract's main entry and local modules", (name) => {
    const text = readFileSync(`${root}src/${name}`, "utf8");
    for (const specifier of specifiers(text)) {
      expect(specifier === "@niho/editor-publish-contract" || /^\.\/[a-z-]+\.js$/.test(specifier), specifier).toBe(true);
    }
    expect(text).not.toContain("test-support");
  });

  it.each(sources)("src/%s does not log", (name) => {
    expect(readFileSync(`${root}src/${name}`, "utf8")).not.toMatch(/\bconsole\./);
  });

  it("depends on the contract only", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@niho/editor-publish-contract": "file:../editor-publish-contract" });
  });
});
