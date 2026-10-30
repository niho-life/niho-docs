import { beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../src/v1.js";
import { serverScenarios, type Outcome } from "./support/server-scenarios.js";
import { readJson } from "./support/synthetic.js";
import { fixtureCaseIds, markdownScenarios, validatorScenarios } from "./support/validator-scenarios.js";
import { buildFixture, type Fixture } from "./support/world.js";

interface ContractCase {
  readonly id: string;
  readonly layer: "server" | "validator" | "markdown";
  readonly mutation: string;
  readonly expected: Outcome;
}

const cases = readJson<{ contractVersion: string; cases: readonly ContractCase[] }>("v1/cases.json");

const registries = {
  server: serverScenarios,
  validator: validatorScenarios,
  markdown: markdownScenarios,
} as const;

const idsOf = (layer: ContractCase["layer"]): string[] =>
  cases.cases.filter((testCase) => testCase.layer === layer).map((testCase) => testCase.id).sort();

describe("v1/cases.json", () => {
  it("is versioned and has unique ids with a mutation and an expectation", () => {
    expect(cases.contractVersion).toBe(CONTRACT_VERSION);
    const ids = cases.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of cases.cases) {
      expect(testCase.mutation.length).toBeGreaterThan(0);
      expect(Object.keys(testCase.expected).length).toBeGreaterThan(0);
    }
  });

  it("matches the scenarios implemented by the tests exactly, layer by layer", () => {
    for (const layer of ["server", "validator", "markdown"] as const) {
      expect(idsOf(layer), layer).toEqual(Object.keys(registries[layer]).sort());
    }
    for (const id of fixtureCaseIds.invalid) expect(idsOf("validator")).toContain(id);
    for (const id of fixtureCaseIds.markdown) expect(idsOf("markdown")).toContain(id);
  });

  it("covers every item of the spec's contract test list", () => {
    const ids = new Set(cases.cases.map((testCase) => testCase.id));
    const required = [
      // Drafts, private and unpublished pages are not listed; unpublished single is 410, the rest 404.
      "list-excludes-draft", "list-excludes-private", "list-excludes-stopped",
      "get-stopped-gone", "get-draft-not-found", "get-private-not-found",
      // Revoked, superseded, other-connection and other-face credentials; no 304 for failed credentials.
      "revoked-key-unauthenticated", "rotated-key-unauthenticated", "other-connection-key-not-found",
      "other-face-token-not-found", "revoked-key-if-none-match-unauthenticated", "rotated-key-if-none-match-unauthenticated",
      // No other destination in a list; unlisted only through a face's include.
      "list-excludes-other-dest", "list-excludes-unlisted-by-default", "list-includes-unlisted-for-face", "site-include-unlisted-invalid",
      // Snapshots ignore draft edits; republishing keeps id and URL.
      "published-ignores-draft-edits", "list-ignores-draft-edits", "republish-same-id-and-url",
      // Preview tokens: expiry, other destination, published endpoints.
      "preview-expired-not-found", "preview-other-face-not-found", "preview-token-as-bearer-unauthenticated", "preview-token-as-published-id-invalid",
      // Face-to-face moves carry movedTo; other cases do not.
      "gone-moved-face-to-face", "gone-face-stopped-no-moved-to", "gone-moved-site-to-face-no-moved-to", "gone-moved-face-to-site-no-moved-to",
      // AST and Markdown negatives.
      "ast-unknown-block", "link-javascript", "image-http-asset-url", "link-userinfo", "link-userinfo-password", "doc-markdown-html",
      // Bad query and id shapes.
      "limit-zero-invalid", "cursor-malformed-invalid", "include-unknown-invalid", "get-malformed-id-invalid",
    ];
    for (const id of required) expect(ids.has(id), id).toBe(true);
  });
});

describe("contract cases", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await buildFixture();
  });

  for (const testCase of cases.cases) {
    it(`${testCase.layer}: ${testCase.id}`, async () => {
      const outcome = testCase.layer === "server"
        ? await serverScenarios[testCase.id]?.(fixture)
        : testCase.layer === "validator"
          ? validatorScenarios[testCase.id]?.()
          : markdownScenarios[testCase.id]?.();
      expect(outcome).toEqual(testCase.expected);
    });
  }
});
