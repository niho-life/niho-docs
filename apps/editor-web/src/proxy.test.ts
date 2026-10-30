// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

function nonceOf(policy: string | null): string {
  const match = /'nonce-([^']+)'/.exec(policy ?? "");
  if (!match?.[1]) throw new Error("no nonce in the policy");
  return match[1];
}

describe("proxy", () => {
  it("puts a Content-Security-Policy with a fresh nonce on every response", () => {
    const first = proxy(new NextRequest("https://editor.example.test/"));
    const second = proxy(new NextRequest("https://editor.example.test/"));
    expect(nonceOf(first.headers.get("Content-Security-Policy"))).not.toBe(nonceOf(second.headers.get("Content-Security-Policy")));
    expect(first.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
  });

  it("hands Next the same policy on the request, so the nonce lands on Next's own scripts", () => {
    const response = proxy(new NextRequest("https://editor.example.test/p/x"));
    // Next は forwarded な要求の header を `x-middleware-request-<name>` と `x-middleware-override-headers` で伝える
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(response.headers.get("Content-Security-Policy"));
    expect(response.headers.get("x-middleware-override-headers")?.toLowerCase()).toContain("content-security-policy");
  });

  it("ignores a Content-Security-Policy sent by the client", () => {
    const request = new NextRequest("https://editor.example.test/", {
      headers: { "Content-Security-Policy": "script-src 'nonce-attacker'" },
    });
    const response = proxy(request);
    expect(response.headers.get("x-middleware-request-content-security-policy")).not.toContain("attacker");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("attacker");
  });

  it("skips the API, static assets and prefetches", () => {
    const [rule] = config.matcher;
    expect(rule?.source).toBe("/((?!api|_next/static|_next/image|favicon.ico).*)");
    expect(rule?.missing).toEqual(
      expect.arrayContaining([
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ]),
    );
  });
});
