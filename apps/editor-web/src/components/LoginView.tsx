"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { LoginScreen } from "niho-docs-ui/shell";
import type { LoginError } from "@/auth/return-to";

/** 失敗の知らせ（どのアカウントだったか・何が起きたかは出さない）。 */
const MESSAGES: Readonly<Record<LoginError, string>> = {
  unavailable: "ログインできませんでした。もう一度お試しください。",
  forbidden: "このアカウントでは入れません。",
};

/**
 * ログインの画面（枠の外）。「NIHOでログイン」で `/auth/login/start` へ移る。next はサーバーで safeReturnTo を通した戻り先（`/` なら null）。
 * 「アカウントを作る」「ヘルプ」の行き先はまだ決まっていない。
 */
export function LoginView({ next, error }: { next: string | null; error: LoginError | null }) {
  return (
    <div data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      {error && <p role="alert">{MESSAGES[error]}</p>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <LoginScreen
          onLogin={() =>
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 行き先は route handler（ページではない）
            window.location.assign(`/auth/login/start${next ? `?next=${encodeURIComponent(next)}` : ""}`)
          }
        />
      </div>
    </div>
  );
}
