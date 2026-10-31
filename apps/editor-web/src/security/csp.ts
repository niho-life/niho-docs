/**
 * editor.niho.life の Content-Security-Policy（#44）。
 *
 * - **script は nonce ＋ `strict-dynamic`**。インラインの script は nonce の無いものを実行せず、`unsafe-inline` も許さない。
 *   nonce は要求ごとに作る（proxy.ts）。Next は要求の CSP から nonce を取り出して自分の script に付ける。
 * - **style は `'self' 'unsafe-inline'`**。TipTap(ProseMirror) が実行時に nonce の無い `<style>` を注入し、
 *   共有の docs-ui が `style=""` 属性を SSR で出すため。XSS で致命的なのは script なので、style の緩和は許容している。
 *   絞るには docs-ui 側で TipTap の `injectNonce` を渡し、`style=""` を class に置き換える必要がある。
 * - 外部 origin を許さない（`default-src 'self'`）。例外は `connect-src` の GCS（`https://storage.googleapis.com`）だけで、
 *   録音の音声をブラウザから保存先の resumable upload のセッション URI へ直接 PUT するため（#36 段 3b-1）。
 *   音声の再生（#36 段 3b-2）は、同じ origin の route（`/api/pages/{id}/recording/audio`）がサーバーで保存先から読み出して流す
 *   （署名付き URL を使わない）ので、`media-src` は `'self' blob:` のまま変えない。
 * - 開発（`next dev`）だけ、React の debug 用の `unsafe-eval` と HMR の WebSocket を許す。本番にはどちらも入れない。
 */
export type CspOptions = { nonce: string; dev: boolean };

/** 録音の音声を PUT する保存先の origin（GCS の resumable upload のセッション URI。src/storage/gcs.ts と同じ）。 */
export const AUDIO_UPLOAD_ORIGIN = "https://storage.googleapis.com";

export function buildCsp({ nonce, dev }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${AUDIO_UPLOAD_ORIGIN}${dev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // http://localhost の開発を壊さないよう、本番だけ
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** JSON の応答（/api）は何も読み込まない。 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 推測できない 128 bit の乱数を base64 にしたもの。要求ごとに 1 つ作る。 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
