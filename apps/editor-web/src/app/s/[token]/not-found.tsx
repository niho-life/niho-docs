/**
 * 共有リンクの 404（形の違う token・共有していない・止めた・作り直す前・ゴミ箱のどれにも同じ画面）。
 * ログインしていない人が見るので、editor の一覧への案内は置かない。
 */
export default function SharedPageNotFound() {
  return (
    <main>
      <h1>ページが見つかりません</h1>
      <p>このリンクではページを見られません。共有した人に確かめてください。</p>
    </main>
  );
}
