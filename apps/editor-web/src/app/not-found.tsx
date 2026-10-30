import Link from "next/link";

/** 別の人のページ・存在しない id・不正な id のどれにも同じ画面を出す。 */
export default function NotFound() {
  return (
    <main>
      <h1>ページが見つかりません</h1>
      <p>
        <Link href="/">ページの一覧へ</Link>
      </p>
    </main>
  );
}
