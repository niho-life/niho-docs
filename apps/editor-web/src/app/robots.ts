import type { MetadataRoute } from "next";

/**
 * クロールは止めない（Disallow を付けると noindex の meta・X-Robots-Tag が読まれず、URL だけが索引に残り得る）。
 * 索引に載せないのは全ページの noindex, nofollow で行う。
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" } };
}
