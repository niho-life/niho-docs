import { useState, type ReactNode } from "react";
import {
  AccountPage,
  DestinationsPage,
  EditorShell,
  LoginScreen,
  PublishPreview,
  PublishSheet,
  SettingsPage,
  ShellHeader,
  SitePage,
  type AccountLink,
  type SettingsAiLang,
  type SettingsEngine,
  type SettingsSaveTo,
  type ShellBodyBlock,
  type ShellDest,
} from "../src/shell";
import { DEST, EXPERIENCES, ME, PAGES, STEP_NAMES, byId, isPublished, slug, urlOf, type GalleryPage } from "./data";
import { navigate, useSettingsSidebar } from "./shared";

/* フェーズ2の画面のギャラリー側の組み立て（モックの V.login / V.preview / V.dest / V.site / V.account / V.settings）。状態はこのファイルの useState。 */

export type PagesForced = { sidebar?: boolean };

export function LoginDemo() {
  return <LoginScreen onLogin={() => navigate("page:j1030")} />;
}

/** 本文の未確認の印（CONFIRM）は、公開版では確かめ済みの文字になる（モックは「8:00」に置き換える）。 */
function resolveConfirm(blocks: ShellBodyBlock[]): ShellBodyBlock[] {
  return blocks.map((block) =>
    block.type === "p" && typeof block.text !== "string" ? { type: "p", text: block.text.map((part) => (typeof part !== "string" && part.kind === "confirm" ? "8:00" : part)) } : block,
  );
}

export function PreviewDemo({ id }: { id: string }) {
  const page: GalleryPage = byId(id) ?? PAGES[0]!;
  const [to, setTo] = useState<ShellDest>(page.pub ? page.pub.dest : page.lang === "ja" ? "niho" : "exp");
  const live = isPublished(page) && Boolean(page.pub) && !page.pub?.updated && to === page.pub?.dest;
  const xp = page.xs[0] ? EXPERIENCES[page.xs[0]] : undefined;
  return (
    <PublishPreview
      title={page.title}
      lead={page.lead}
      category={page.cat}
      lang={page.lang}
      body={resolveConfirm(page.body)}
      slug={slug(page)}
      date={page.pub?.date ?? "2026-10-30"}
      author={{ name: ME.name, title: page.lang === "ja" ? ME.titleJa : ME.titleEn, initial: ME.initial }}
      to={to}
      dests={(Object.keys(DEST) as ShellDest[]).map((key) => ({ id: key, host: DEST[key].host, path: DEST[key].path }))}
      live={live}
      siteHost={ME.site}
      experience={xp ? { title: xp.title, price: xp.price, from: xp.from } : undefined}
      onBack={() => navigate(`page:${page.id}`)}
      onTo={setTo}
    />
  );
}

/** 設定系ページの枠（左の一覧＋ヘッダー＋ページ）。ページは選ばれていない。 */
function SettingsFrame({ current, title, sidebar: forcedSidebar, pendingInvites = 0, overlay, children }: { current: "dest" | "account" | "settings"; title: string; sidebar?: boolean; pendingInvites?: number; overlay?: ReactNode; children: ReactNode }) {
  const { sidebar, sidebarOpen, setSidebarOpen } = useSettingsSidebar(current, forcedSidebar, pendingInvites);
  return (
    <EditorShell
      sidebar={sidebar}
      header={<ShellHeader plain title={title} showListButton={!sidebarOpen} onToggleList={() => setSidebarOpen(true)} />}
      sidebarOpen={sidebarOpen}
      railOpen={false}
      overlay={overlay}
    >
      {children}
    </EditorShell>
  );
}

const connectedSite = (forced: { conn?: boolean }) => forced.conn ?? true;

export function DestDemo({ forced, addDest }: { forced: PagesForced & { conn?: boolean }; addDest?: boolean }) {
  const [sheet, setSheet] = useState(Boolean(addDest));
  const rows = (Object.keys(DEST) as ShellDest[]).map((key) => ({
    id: key,
    label: DEST[key].label,
    host: DEST[key].host,
    path: DEST[key].path,
    who: DEST[key].who,
    role: DEST[key].role,
    connected: key !== "site" || connectedSite(forced),
    published: PAGES.filter((page) => isPublished(page) && page.pub?.dest === key).length,
  }));
  return (
    <SettingsFrame
      current="dest"
      title="発信先"
      sidebar={forced.sidebar}
      pendingInvites={1}
      overlay={sheet ? <PublishSheet kind="addDest" onPick={() => navigate("site")} onClose={() => setSheet(false)} /> : undefined}
    >
      <DestinationsPage dests={rows} onOpenSite={() => navigate("site")} onAdd={() => setSheet(true)} />
    </SettingsFrame>
  );
}

export function SiteDemo({ forced }: { forced: PagesForced }) {
  const [wordpress, setWordpress] = useState(false);
  return (
    <SettingsFrame current="dest" title={ME.site} sidebar={forced.sidebar} pendingInvites={1}>
      <SitePage
        host={ME.site}
        apiUrl="https://api.editor.niho.life/v1/mika/published.json"
        maskedKey="pk_site_•••••••••••3f9a"
        wordpress={{ on: wordpress }}
        articleUrl={`${ME.site}/posts/{slug}`}
        published={PAGES.filter((page) => isPublished(page) && page.pub?.dest === "site").map((page) => ({ id: page.id, title: page.title, url: urlOf(page, "site") }))}
        onBack={() => navigate("dest")}
        onWordpress={setWordpress}
      />
    </SettingsFrame>
  );
}

export function AccountDemo({ forced }: { forced: PagesForced }) {
  const [pending, setPending] = useState(true);
  const links: AccountLink[] = [
    { id: "sora", provider: "Sora's Zen Mornings", initial: "S", experience: EXPERIENCES.zazen!.title, pages: 1 },
    ...(pending ? [] : [{ id: "niho-kamakura", provider: "NIHO kamakura", initial: "N", experience: EXPERIENCES.dinner!.title, pages: 1 }]),
  ];
  return (
    <SettingsFrame current="account" title="役割とつながり" sidebar={forced.sidebar} pendingInvites={pending ? 1 : 0}>
      <AccountPage
        account={{ name: ME.name, initial: ME.initial, email: ME.email }}
        roles={[
          { id: "writer", name: "ライター", detail: "NIHO Experience · NIHO 事務局の招待 · 2026-10-29", dest: "exp" },
          { id: "local", name: "鎌倉の人", detail: "NIHO", dest: "niho" },
          { id: "host", name: "体験ホスト", detail: "体験を掲載するには NIHO Experience で申し込み", off: { action: "申し込む" } },
        ]}
        invite={pending ? { initial: "N", name: "NIHO kamakura", detail: "Takuya · 公開中の体験を記事に関連付け" } : null}
        links={links}
        onAccept={() => setPending(false)}
        onDecline={() => setPending(false)}
      />
    </SettingsFrame>
  );
}

export function SettingsDemo({ forced }: { forced: PagesForced }) {
  const [profile, setProfile] = useState({ name: ME.name, titleJa: ME.titleJa, titleEn: ME.titleEn, bio: "2019年に鎌倉へ。毎朝、北鎌倉の寺の道を歩いています。" });
  const [aiLang, setAiLang] = useState<SettingsAiLang>("same");
  const [engine, setEngine] = useState<SettingsEngine>("mac");
  const [speakers, setSpeakers] = useState(true);
  const [saveTo, setSaveTo] = useState<SettingsSaveTo>("cloud");
  return (
    <SettingsFrame current="settings" title="設定" sidebar={forced.sidebar} pendingInvites={1}>
      <SettingsPage
        profile={{ initial: ME.initial, ...profile }}
        onProfile={(field, value) => setProfile((current) => ({ ...current, [field]: value }))}
        aiLang={aiLang}
        onAiLang={setAiLang}
        terms="北鎌倉 · 円覚寺 · 材木座 · NIHO kamakura"
        recipes={Object.entries(STEP_NAMES).map(([name, steps]) => ({ id: name, name, steps }))}
        engine={engine}
        onEngine={setEngine}
        speakers={speakers}
        onSpeakers={setSpeakers}
        saveTo={saveTo}
        onSaveTo={setSaveTo}
        onLogout={() => navigate("login")}
      />
    </SettingsFrame>
  );
}
