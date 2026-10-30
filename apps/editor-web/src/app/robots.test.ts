import { describe, expect, it } from "vitest";
import nextConfig, { ROBOTS_HEADERS } from "../../next.config";
import { metadata } from "./layout";
import robots from "./robots";

describe("noindex, nofollow", () => {
  it("sends X-Robots-Tag on every path through one catch-all header rule", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const catchAll = rules.find((rule) => rule.source === "/:path*");
    expect(catchAll).toBeDefined();
    expect(catchAll?.headers).toEqual(expect.arrayContaining(ROBOTS_HEADERS));
    expect(ROBOTS_HEADERS).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
    // 一部の path だけに条件を付けた規則で上書きしない
    for (const rule of rules) expect(rule.has ?? rule.missing).toBeUndefined();
  });

  it("puts <meta name=robots content=noindex, nofollow> on every page through the root layout", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not block crawling in robots.txt (a Disallow would hide the noindex)", () => {
    const result = robots();
    expect(JSON.stringify(result).toLowerCase()).not.toContain("disallow");
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
  });
});
