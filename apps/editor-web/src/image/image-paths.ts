/**
 * 画像の中身を読む path（#33）。実体は private bucket にあり、**サーバーが中継する**（署名付き URL はブラウザへ渡さない）。
 * 本文（AST）に入れるのは資産の id だけなので、path は描くときにここで組む。
 */

/** 本人の画像（`GET /api/assets/{id}`。src/server/images-api.ts の readImageRoute）。 */
export function imageAssetPath(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}`;
}

/** 共有リンクのページの画像（`GET /s/{token}/a/{id}`。ログイン不要）。 */
export function sharedImagePath(token: string, assetId: string): string {
  return `/s/${encodeURIComponent(token)}/a/${encodeURIComponent(assetId)}`;
}
