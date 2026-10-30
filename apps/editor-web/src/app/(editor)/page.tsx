import Link from "next/link";
import { UNTITLED_DOC } from "@niho/docs-core";
import { NewPageButton } from "@/components/NewPageButton";
import { LoginRequired, StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { currentSession } from "@/server/session";

export const dynamic = "force-dynamic";

const updatedFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" });

/** 自分のページの一覧（更新順）と「新しいページ」。サイドバー・絞り込みは #32。 */
export default async function HomePage() {
  const session = await currentSession();
  if (!session) return <LoginRequired />;
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const pages = await store.listPages(session.userId);
  return (
    <main>
      <h1>ページ</h1>
      <NewPageButton />
      {pages.length === 0 ? (
        <p>まだページはありません。</p>
      ) : (
        <ul>
          {pages.map((page) => (
            <li key={page.id}>
              <Link href={`/p/${page.id}`}>{page.title.trim() || UNTITLED_DOC}</Link>{" "}
              <time dateTime={page.updatedAt}>{updatedFormat.format(new Date(page.updatedAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
