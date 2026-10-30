import Link from "next/link";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/PageEditor";
import { LoginRequired, StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { currentSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** ページ。別の人のページ・存在しない id・UUID として不正な id はどれも同じ 404。 */
export default async function PageView(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await currentSession();
  if (!session) return <LoginRequired />;
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const page = await store.getPage(session.userId, id);
  if (!page) notFound();
  return (
    <main>
      <nav>
        <Link href="/">ページの一覧</Link>
      </nav>
      <PageEditor key={page.id} page={{ id: page.id, title: page.title, blocks: page.blocks }} />
    </main>
  );
}
