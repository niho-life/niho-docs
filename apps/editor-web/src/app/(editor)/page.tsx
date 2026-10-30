import { cookies } from "next/headers";
import { HomeRedirect } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { LAST_PAGE_COOKIE } from "@/lib/last-page";
import { getStore } from "@/server/db";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** `/`。デスクトップでは最後に開いたページ（無い・消えた・別の人のものなら新しいページ）へ移る。狭い画面では一覧がこの画面。 */
export default async function HomePage() {
  const session = await requireSession("/");
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const last = (await cookies()).get(LAST_PAGE_COOKIE)?.value;
  const page = last ? await store.getPage(session.userId, last) : null;
  return <HomeRedirect lastPageId={page?.id ?? null} />;
}
