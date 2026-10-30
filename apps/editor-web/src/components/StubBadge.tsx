import { connection } from "next/server";
import { resolveAuthMode } from "@/auth/config";

/** EDITOR_AUTH_MODE=stub のとき、画面の隅に「stub」と出す（機能上の表示だけ。見た目は #48）。 */
export async function StubBadge() {
  // build のときに値を焼き込まず、要求のときの環境で決める
  await connection();
  let stub = false;
  try {
    stub = resolveAuthMode(process.env) === "stub";
  } catch {
    stub = false;
  }
  if (!stub) return null;
  return (
    <div data-auth-mode="stub" style={{ position: "fixed", right: 8, bottom: 8, fontSize: 12 }}>
      stub
    </div>
  );
}
