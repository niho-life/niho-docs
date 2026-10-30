import type { Metadata } from "next";
import { SettingsScreen } from "@/components/FramePages";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "役割とつながり" };

/** 役割とつながり（題名だけ。中身は #42）。 */
export default async function AccountPage() {
  await requireSession("/account");
  return <SettingsScreen title="役割とつながり" />;
}
