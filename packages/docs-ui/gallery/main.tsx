import "niho-ui/styles/tokens.css";
import "niho-ui/styles/editor-tokens.css";
import "../src/styles/shell.css";
import "./gallery.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check } from "./check";
import { AccountDemo, DestDemo, LoginDemo, PreviewDemo, SettingsDemo, SiteDemo } from "./pages";
import type { ShellDest } from "../src/shell";
import { Screen, type ScreenForced } from "./screen";
import { SCREENS, findScreen, parseHash } from "./screens";

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { hash, ...parseHash(hash) };
}

function Index() {
  return (
    <main className="g-index">
      <h1>NIHO editor 枠（shell）ギャラリー</h1>
      <p>モック v6（#48）フェーズ1・2の画面。状態はこのページの useState で持ち、DocsHost・通信・保存は使わない。</p>
      <ul>
        {SCREENS.map((screen) => (
          <li key={screen.id}>
            <a href={`#/${screen.id}`}>{screen.label}</a> <code>{screen.id}</code>
          </li>
        ))}
        <li>
          <a href="#/_check">横スクロールの確認（全画面 × 1440 / 390 / 320）</a> <code>_check</code>
        </li>
      </ul>
    </main>
  );
}

const DESTS: ShellDest[] = ["exp", "niho", "site"];

/** 画面の中身。page: / new / newrec / sel: / sheet:publish / sheet:done は枠の画面（Screen）、それ以外はフェーズ2の画面。 */
function Body({ id, forced }: { id: string; forced: ScreenForced }) {
  const [name = "", arg = ""] = id.split(":");
  if (name === "login") return <LoginDemo />;
  if (name === "preview") return <PreviewDemo id={arg || "kita"} />;
  if (name === "dest") return <DestDemo forced={forced} />;
  if (name === "site") return <SiteDemo forced={forced} />;
  if (name === "account") return <AccountDemo forced={forced} />;
  if (name === "settings") return <SettingsDemo forced={forced} />;
  if (name === "sheet" && arg === "addDest") return <DestDemo forced={forced} addDest />;
  return <Screen id={id} forced={forced} />;
}

function App() {
  const { hash, route, params } = useRoute();
  if (route === "" ) return <Index />;
  if (route === "_check") return <Check />;
  const id = route.startsWith("page:") || route.startsWith("preview:") || findScreen(route) ? route : "";
  if (!id) return <Index />;
  const pick = params.get("pick");
  const forced: ScreenForced = {
    sidebar: params.has("sidebar") ? params.get("sidebar") === "1" : undefined,
    rail: params.has("rail") ? params.get("rail") === "1" : undefined,
    pick: DESTS.find((dest) => dest === pick),
    conn: params.has("conn") ? params.get("conn") === "1" : undefined,
    page: params.get("page") ?? undefined,
  };
  // 画面を替えたら状態を作り直す（モックの render と同じ）
  return (
    <div className="g-frame" data-docs-app-root data-docs-shared-ui>
      <Body key={hash} id={id} forced={forced} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
