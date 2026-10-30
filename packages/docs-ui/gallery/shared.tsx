import { useMemo, useState, type ReactNode } from "react";
import { ShellSidebar, shellAccountItems, type ShellListItem } from "../src/shell";
import { DEST, ME, PAGES, byId, isPublished, type GalleryPage } from "./data";

export const navigate = (route: string) => {
  window.location.hash = `#/${route}`;
};
export const isNarrow = () => window.matchMedia("(max-width:900px)").matches;

/** 左の一覧の行（モックの sidebar()）。2 行目は公開先・録音・作成中のときだけ。 */
export function listItems(extraNew: boolean): ShellListItem[] {
  const sub = (page: GalleryPage): ShellListItem["sub"] =>
    isPublished(page) && page.pub
      ? { text: DEST[page.pub.dest].label, dest: page.pub.dest }
      : page.pub
        ? { text: "公開をやめた" }
        : page.kind === "rec"
          ? { text: "録音" }
          : page.st === "run"
            ? { text: "作成中…" }
            : undefined;
  const item = (page: GalleryPage, child?: boolean): ShellListItem => ({ id: page.id, title: page.title, when: page.saved, child, sub: sub(page) });
  const rows = PAGES.filter((page) => !page.parent).flatMap((page) => [
    item(page),
    ...(page.children ?? []).flatMap((childId) => {
      const child = byId(childId);
      return child ? [item(child, true)] : [];
    }),
  ]);
  return extraNew ? [{ id: "new", title: "", when: "たった今" }, ...rows] : rows;
}

/** 発信先・役割とつながり・設定のページで使う左の一覧（ページは選ばれていない。本人の行に現在地を示す）。 */
export function useSettingsSidebar(current: "dest" | "account" | "settings", forced: boolean | undefined, pendingInvites: number): { sidebar: ReactNode; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void } {
  const [sidebarOpen, setSidebarOpen] = useState(forced ?? !isNarrow());
  const [newMenu, setNewMenu] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [search, setSearch] = useState({ open: false, value: "" });
  const items = useMemo(() => listItems(false), []);
  const query = search.value.trim();
  const shown = query ? items.filter((item) => item.title.includes(query)) : items;
  const sidebar = (
    <ShellSidebar
      items={shown}
      onSelect={(itemId) => navigate(`page:${itemId}`)}
      onCollapse={() => setSidebarOpen(false)}
      newMenu={{
        open: newMenu,
        onToggle: () => setNewMenu((v) => !v),
        onClose: () => setNewMenu(false),
        onPick: (kind) => navigate(kind === "recording" ? "newrec" : "new"),
      }}
      search={{
        open: search.open,
        value: search.value,
        onOpen: () => setSearch({ open: true, value: "" }),
        onClose: () => setSearch({ open: false, value: "" }),
        onChange: (value) => setSearch({ open: true, value }),
      }}
      me={{
        name: ME.name,
        caption: ME.email,
        initial: ME.initial,
        badge: pendingInvites || undefined,
        open: accountMenu,
        current: true,
        items: shellAccountItems(pendingInvites, current),
        onToggle: () => setAccountMenu((v) => !v),
        onClose: () => setAccountMenu(false),
        onSelect: (id) => {
          setAccountMenu(false);
          if (id === "logout") navigate("login");
          else navigate(id);
        },
      }}
    />
  );
  return { sidebar, sidebarOpen, setSidebarOpen };
}
