import { describe, expect, it } from "vitest";
import { API_CSP, buildCsp, newNonce } from "./csp";

const NONCE = "c3ludGhldGljLW5vbmNl";

function directive(policy: string, name: string): string[] {
  const found = policy.split("; ").find((part) => part === name || part.startsWith(`${name} `));
  return found ? found.slice(name.length).trim().split(/\s+/).filter(Boolean) : [];
}

describe("buildCsp (production)", () => {
  const policy = buildCsp({ nonce: NONCE, dev: false });

  it("runs only scripts that carry this request's nonce, and never allows unsafe-inline or unsafe-eval scripts", () => {
    const script = directive(policy, "script-src");
    expect(script).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("loads nothing from another origin and cannot be framed or re-based", () => {
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(policy).not.toMatch(/https?:|\*/);
  });

  it("allows the manifest and the service worker only from this origin, and upgrades insecure requests", () => {
    expect(directive(policy, "manifest-src")).toEqual(["'self'"]);
    expect(directive(policy, "worker-src")).toEqual(["'self'"]);
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("limits connections to this origin (no WebSocket)", () => {
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
  });
});

describe("buildCsp (development)", () => {
  const policy = buildCsp({ nonce: NONCE, dev: true });

  it("adds only what next dev needs: unsafe-eval for scripts and a WebSocket for HMR, and no upgrade-insecure-requests", () => {
    expect(directive(policy, "script-src")).toContain("'unsafe-eval'");
    expect(directive(policy, "connect-src")).toEqual(["'self'", "ws:", "wss:"]);
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});

describe("newNonce", () => {
  it("is 128 bits of base64 that differs on every call", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(atob(nonce)).toHaveLength(16);
    }
  });

  it("cannot break out of the header it is written into", () => {
    expect(buildCsp({ nonce: newNonce(), dev: false })).not.toMatch(/[\r\n]/);
  });
});

describe("API_CSP", () => {
  it("loads nothing", () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
