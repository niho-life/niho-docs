import type { Metadata } from "next";
import { SettingsScreen } from "@/components/FramePages";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "設定" };

/** 設定（題名だけ。中身はこの後の Issue）。 */
export default async function SettingsPage() {
  await requireSession("/settings");
  return <SettingsScreen title="設定" />;
}
