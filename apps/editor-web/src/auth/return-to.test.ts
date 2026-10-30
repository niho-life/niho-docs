import { describe, expect, it } from "vitest";
import { loginPath, safeReturnTo, seeOther } from "./return-to";

const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

describe("safeReturnTo", () => {
  it("keeps the editor's own screens", () => {
    for (const path of ["/", "/p/new", `/p/${ID}`, `/p/${ID.toUpperCase()}`, "/destinations", "/destinations/my-site-1", "/account", "/settings"]) {
      expect(safeReturnTo(path), path).toBe(path);
    }
    expect(safeReturnTo("/p/new?from=recording")).toBe("/p/new?from=recording");
  });

  it("drops the query and the hash, except the recording start", () => {
    expect(safeReturnTo(`/p/${ID}?x=1#top`)).toBe(`/p/${ID}`);
    expect(safeReturnTo("/settings?tab=ai")).toBe("/settings");
    expect(safeReturnTo("/p/new?from=recording&x=1")).toBe("/p/new");
    expect(safeReturnTo("/p/new?from=file")).toBe("/p/new");
    expect(safeReturnTo("/p/new?from=recording#x")).toBe("/p/new?from=recording");
  });

  it("answers / to anything that could leave the editor (open redirect)", () => {
    for (const raw of [
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "/p/\\..\\..\\evil",
      "https://evil.com",
      "http:/evil.com",
      "evil.com",
      "javascript:alert(1)",
      "/%2F%2Fevil.com",
      "/%2f%2fevil.com",
      "/%5Cevil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/%09/evil.com",
      "/%0a/evil.com",
      "/p/\u0000",
      "/p/\u007f",
      "/p/\u0085",
      " /p/new",
    ]) {
      expect(safeReturnTo(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("answers / to paths outside the allowlist", () => {
    for (const raw of [
      "/p/not-a-uuid",
      `/p/${ID}/preview`,
      `/p/${ID}x`,
      "/p/",
      "/P/new",
      "/auth/login",
      "/auth/callback",
      "/auth/logout",
      "/api/pages",
      `/api/pages/${ID}`,
      "/destinations/",
      "/destinations/My_Site",
      `/destinations/${"a".repeat(65)}`,
      "/p/%2e%2e/auth/login",
      "/p/../api/pages",
      "/robots.txt",
      "/_next/static/x.js",
      "/no-such-route",
    ]) {
      expect(safeReturnTo(raw), raw).toBe("/");
    }
  });

  it("answers / to empty, missing, and over-long values", () => {
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo(`/p/${ID}?${"x".repeat(2048)}`)).toBe("/");
    expect(safeReturnTo(`/p/${ID}?${"x".repeat(1000)}`)).toBe(`/p/${ID}`);
  });
});

describe("loginPath", () => {
  it("omits next for / and encodes it otherwise", () => {
    expect(loginPath("/")).toBe("/auth/login");
    expect(loginPath(`/p/${ID}`)).toBe(`/auth/login?next=%2Fp%2F${ID}`);
    expect(loginPath("/p/new?from=recording")).toBe("/auth/login?next=%2Fp%2Fnew%3Ffrom%3Drecording");
    expect(loginPath("/settings", "unavailable")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
    expect(loginPath("/", "unavailable")).toBe("/auth/login?error=unavailable");
  });

  it("never carries a return path that safeReturnTo would refuse", () => {
    expect(loginPath("//evil.com")).toBe("/auth/login");
    expect(loginPath("/auth/login?next=%2Fsettings")).toBe("/auth/login");
  });
});

describe("seeOther", () => {
  it("is an uncacheable 303 to a same-origin path", () => {
    const response = seeOther("/p/new");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/p/new");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
