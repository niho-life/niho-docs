import type { Metadata } from "next";
import type { ReactNode } from "react";
import { StubBadge } from "@/components/StubBadge";

// editor.niho.life は全ページ noindex, nofollow（設計 §2）。header の X-Robots-Tag は next.config.ts で全 route に付ける。
export const metadata: Metadata = {
  title: { default: "NIHO editor", template: "%s · NIHO editor" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        <StubBadge />
      </body>
    </html>
  );
}
