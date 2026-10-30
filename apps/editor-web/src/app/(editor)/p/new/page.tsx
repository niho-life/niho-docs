import { NewPage, RecordingStartScreen } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** 新しいページ（題名か本文を入力した時点で作り、`/p/{id}` になる）。`?from=recording` は録音の開始の画面。 */
export default async function NewPageView(props: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await props.searchParams;
  const recording = from === "recording";
  await requireSession(recording ? "/p/new?from=recording" : "/p/new");
  if (!getStore()) return <StoreUnavailable />;
  return recording ? <RecordingStartScreen /> : <NewPage />;
}
