import type { Metadata } from "next";
import { StoreUnavailable } from "@/components/Notice";
import { DestinationsView } from "@/components/DestinationsView";
import { connectionsDeps } from "@/server/connections-deps";
import { destinationsFor } from "@/server/connections-api";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "発信先" };

/**
 * 発信先（#41）。NIHO の面は役割で自動に出て、本人のサイトは「発信先を追加」で接続する。
 * 最初の値はここで読む（画面を開いたときに空から始めない）。
 */
export default async function DestinationsPage() {
  const session = await requireSession("/destinations");
  const wiring = connectionsDeps.ports(session);
  if (!wiring) return <StoreUnavailable />;
  const destinations = await destinationsFor(wiring, session.userId);
  return <DestinationsView initial={destinations} />;
}
