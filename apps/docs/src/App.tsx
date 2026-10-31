import { useNihoAccount } from "niho-desktop-account/use-niho-account";
import type { AccountTransport } from "niho-desktop-account/account-bridge";
import { DocsApp } from "niho-docs-ui/screens/DocsApp";
import type { DocsHost } from "niho-docs-ui/host/DocsHost";
import { EditorScreen } from "./editor/EditorScreen";

/** 本人の行（新しい画面の左下）。ログインしていなければ、その旨だけを出す。 */
function meOf(account: ReturnType<typeof useNihoAccount>): { name: string; caption: string; initial: string } {
  const profile = account.state && "profile" in account.state ? account.state.profile : null;
  if (!profile) return { name: "ログインしていません", caption: "設定からログイン", initial: "?" };
  return {
    name: profile.displayName,
    caption: profile.handle ? `@${profile.handle}` : "NIHO アカウント",
    initial: Array.from(profile.displayName.trim())[0] ?? "N",
  };
}

/**
 * Mac のアカウント接続だけを持ち、共通の画面を描く。
 * `capabilities.editorShell`（環境変数 `VITE_NIHO_DOCS_EDITOR_SHELL=true`）のときだけ、新しい editor の画面（#45 第 1 段）を出す。
 * 既定は今までの画面（保存先・フォルダ・録音・工程・AI はそのまま動く）。
 */
export function App(props: { bridge: DocsHost; accountTransport?: AccountTransport }) {
  const account = useNihoAccount({ lang: "ja", transport: props.accountTransport });
  if (props.bridge.capabilities?.editorShell === true) return <EditorScreen bridge={props.bridge} me={meOf(account)} />;
  return <DocsApp bridge={props.bridge} account={account} />;
}
