import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { EDITOR_PATH_HEADER } from "./lib/editor-path";
import { config, proxy } from "./proxy";

/** NextResponse.next({ request: { headers } }) が上流へ渡す要求の header。 */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("proxy", () => {
  it("forwards the current path and search, overwriting a client-supplied value", () => {
    const request = new NextRequest("http://editor.test/p/new?from=recording", { headers: { [EDITOR_PATH_HEADER]: "//evil.com" } });
    const response = proxy(request);
    expect(forwarded(response, EDITOR_PATH_HEADER)).toBe("/p/new?from=recording");
    expect(response.headers.get("location")).toBeNull();
  });

  it("runs for screens only, not for /api, /auth, /_next, or files", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const path of ["/", "/p/new", "/p/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", "/settings", "/destinations/my-site", "/no-such-route", "/apiary", "/authors"]) {
      expect(matches(`http://editor.test${path}`), path).toBe(true);
    }
    for (const path of ["/api", "/api/pages", "/auth/login", "/auth/login/start", "/auth/callback", "/_next/static/chunks/x.js", "/robots.txt", "/favicon.ico"]) {
      expect(matches(`http://editor.test${path}`), path).toBe(false);
    }
  });
});
