import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { StubBadge } from "@/components/StubBadge";

// editor.niho.life は全ページ noindex, nofollow（設計 §2）。header の X-Robots-Tag は next.config.ts で全 route に付ける。
export const metadata: Metadata = {
  title: { default: "NIHO editor", template: "%s · NIHO editor" },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // 全ての route を要求のときに描く。CSP の nonce は要求ごとに変わるので、build のときの静的な HTML には入れられない（src/proxy.ts）
  await connection();
  return (
    <html lang="ja">
      <body>
        {children}
        <StubBadge />
      </body>
    </html>
  );
}
