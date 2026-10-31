/**
 * 共通実装は packages/docs-ui（Mac・Web で同じ schema。#45）。Web はここで画像の src（サーバーの中継の path）を入れて渡す。
 */
import { buildPageExtensions as buildSharedPageExtensions, type PageExtensionsOptions } from "niho-docs-ui/page/page-extensions";
import { imageAssetPath } from "@/image/image-paths";
import type { Extensions } from "@tiptap/core";

export type { PageExtensionsOptions };

export function buildPageExtensions(options: PageExtensionsOptions = {}): Extensions {
  return buildSharedPageExtensions({ srcOf: imageAssetPath, ...options });
}
