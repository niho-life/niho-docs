import type { Metadata } from "next";
import { SettingsScreen } from "@/components/FramePages";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "発信先" };

/** 発信先（題名だけ。中身は #41）。 */
export default async function DestinationsPage() {
  await requireSession("/destinations");
  return <SettingsScreen title="発信先" />;
}
