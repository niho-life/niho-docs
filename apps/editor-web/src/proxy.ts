import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "@/security/csp";

/**
 * 要求ごとに nonce を作り、CSP を要求と応答の両方に付ける（Next は要求側の CSP から nonce を取り出して
 * 自分の script に付ける）。client が送ってきた CSP の header は信用せず、必ず上書きする。
 * 本文を描く route は動的に描く（layout.tsx）。静的に作った HTML には nonce を入れられない。
 */
export function proxy(request: NextRequest) {
  const csp = buildCsp({ nonce: newNonce(), dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // API は JSON だけなので next.config.ts の固定の CSP を使う。静的ファイルと prefetch には要らない
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
