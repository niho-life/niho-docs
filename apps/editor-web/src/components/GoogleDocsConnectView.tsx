import Link from "next/link";
import type { GoogleDocsConnection } from "@/google-docs/gateway";

/**
 * Google ドキュメントへの書き出しの接続の案内（枠の外。`/google-docs/connect`）。
 *
 * つながりを持つのは NIHO 側で、editor は状態を見せて入口を出すだけ（設計 §5・§6）。JavaScript は要らない
 * （「接続する」「接続をやめる」はどちらも同じ origin への form。token はブラウザに渡らない）。
 */
export function GoogleDocsConnectView(props: {
  /** 読めなかったときは null（方式が閉じている・NIHO の API を呼べない）。 */
  connection: GoogleDocsConnection | null;
  /** 直前の失敗の短い code。 */
  error: string | null;
  /** 書き出そうとしていたページへ戻る path（`/` なら出さない）。 */
  returnTo: string;
}) {
  const { connection, error, returnTo } = props;
  const query = returnTo === "/" ? "" : `?next=${encodeURIComponent(returnTo)}`;
  const connected = connection?.status === "CONNECTED";
  return (
    <main>
      <h1>Google ドキュメントへの書き出し</h1>
      {error !== null && (
        <p role="alert">
          {MESSAGES[error] ?? "Google ドキュメントにつなげませんでした。しばらくしてから、もう一度お試しください。"}
        </p>
      )}
      {connection === null && <p>この editor では、まだ Google ドキュメントへ書き出せません。</p>}
      {connection !== null && !connected && (
        <>
          <p>
            ページを Google ドキュメントにするには、一度だけ NIHO と Google をつなぎます。つながりは NIHO が持ち、
            editor は書き出しを頼むだけです。
          </p>
          <form method="post" action={`/api/google-docs/connect${query}`}>
            <button type="submit">接続する</button>
          </form>
        </>
      )}
      {connected && (
        <>
          <p>
            {connection.connectedEmail} につながっています。ページの「…」から「Google ドキュメントへ」を選ぶと、
            このアカウントのドライブに文書ができます。
          </p>
          <form method="post" action={`/api/google-docs/disconnect?redirect=1${query ? `&${query.slice(1)}` : ""}`}>
            <button type="submit">接続をやめる</button>
          </form>
        </>
      )}
      {returnTo !== "/" && <p><Link href={returnTo}>ページへ戻る</Link></p>}
    </main>
  );
}

/** 失敗の code ごとの一言（値・内部の情報は出さない）。 */
const MESSAGES: Readonly<Record<string, string>> = {
  google_docs_unavailable: "Google ドキュメントへの書き出しは、まだ使えません。",
  app_not_allowed: "NIHO 側の許可を待っています。",
  temporarily_unavailable: "いまは混み合っています。少し待ってから、もう一度お試しください。",
  signed_out: "ログインし直してください。",
  drive_reconnect_required: "つなぎ直してください。",
  drive_not_connected: "まだつながっていません。",
};
