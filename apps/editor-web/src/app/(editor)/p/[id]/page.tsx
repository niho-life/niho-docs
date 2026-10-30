import { notFound } from "next/navigation";
import { OpenPage } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** ページ。別の人のページ・存在しない id・UUID として不正な id はどれも同じ 404。 */
export default async function PageView(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await requireSession(`/p/${id}`);
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const page = await store.getPage(session.userId, id);
  if (!page) notFound();
  const { kind, title, lang, parent, stepStatus, createdAt, updatedAt } = page;
  return <OpenPage key={page.id} summary={{ id: page.id, kind, title, lang, parent, stepStatus, createdAt, updatedAt }} blocks={page.blocks} />;
}
