import type { ReactNode } from "react";

/** ページの代わりに出す短い知らせ（保存先が無いとき）。 */
export function Notice(props: { title: string; children: ReactNode }) {
  return (
    <main>
      <h1>{props.title}</h1>
      <p>{props.children}</p>
    </main>
  );
}

export function StoreUnavailable() {
  return <Notice title="保存先を使えません">サーバーの保存先（DATABASE_URL）が設定されていません。</Notice>;
}
