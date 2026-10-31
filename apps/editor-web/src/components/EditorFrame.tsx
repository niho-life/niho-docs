"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PageSummary } from "@niho/editor-store";
import { EditorShell, ShellHeader, ShellSidebar, shellAccountItems, shellPublishButton, type NewPageKind } from "niho-docs-ui/shell";
import { listPagesRequest } from "@/lib/pages-client";
import { useShortcuts } from "@/lib/shortcuts";
import { arrangeSidebarItems } from "@/lib/sidebar-items";
import { useSearchShortcut } from "@/lib/use-search-shortcut";
import { FramePublishSheet, PublishNotice, type FramePublishKind } from "./FramePublish";

/** shell.css と同じ境目（これ以下は一覧・ページのどちらかを全画面で出す）。 */
const NARROW_QUERY = "(max-width: 900px)";

const PAGE_PATH = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 設定系のページ（本人の行のメニューの項目と、ヘッダーの題名）。 */
const SETTINGS_ROUTES = [
  { path: "/destinations", item: "dest", title: "発信先" },
  { path: "/account", item: "account", title: "役割とつながり" },
  { path: "/settings", item: "settings", title: "設定" },
] as const;

export type FrameMe = { name: string; caption: string; initial: string };

export type FrameInitial = {
  pages: PageSummary[];
  next: string | null;
  /** サーバーで描いた時刻（一覧の「N分前」を、ブラウザの最初の描画でも同じにする）。 */
  now: number;
  me: FrameMe;
  /** 要求の header から推した狭い画面か（ブラウザでは matchMedia に替わる）。 */
  initialNarrow: boolean;
};

/** ページの画面から枠（一覧・ヘッダー）へ知らせること。 */
export type EditorFrameApi = {
  narrow: boolean;
  /** 開いたページ。一覧に読み込んでいない古いページでも、ヘッダーに題名を出し、保存したら一覧の上に足す。 */
  pageOpened: (page: PageSummary) => void;
  pageTitleChanged: (id: string, title: string) => void;
  /** 保存した。一覧の上へ動かし、時刻を今にする。 */
  pageSaved: (id: string) => void;
  /** 新しいページを作った。一覧の上に足す。 */
  pageCreated: (id: string, title: string) => void;
  /** 公開のシートを開く（ページを開いている画面だけで出る）。 */
  openPublish: () => void;
};

const noop = () => undefined;

const FrameContext = createContext<EditorFrameApi>({ narrow: false, pageOpened: noop, pageTitleChanged: noop, pageSaved: noop, pageCreated: noop, openPublish: noop });

export function useEditorFrame(): EditorFrameApi {
  return useContext(FrameContext);
}

/** 今、狭い画面か（effect の中で読む。描画には useEditorFrame().narrow を使う）。 */
export function isNarrowNow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 一覧（読み込んだ分）と、開いているページ（一覧に無いこともある）。 */
type ListState = { pages: PageSummary[]; next: string | null; opened: PageSummary | null };

function toTop(pages: PageSummary[], page: PageSummary): PageSummary[] {
  return [page, ...pages.filter((item) => item.id !== page.id)];
}

/**
 * editor の枠（一覧＋ヘッダー＋ページ）。見た目は niho-docs-ui の shell（#48）。ここは状態と移動だけを持つ。
 * - 一覧は最初の区切りをサーバーから受け、末尾が近づいたら続きを読む。
 * - 900px 以下では `/` が一覧の画面。ページと設定は全画面で、ヘッダーの左のボタンで一覧を出す。
 * - ショートカット（設計 §11）: ⌘N 新しいページ、⌘K 検索、⌘⇧P 公開のシート（⌘S はページ、⌘/ は本文が持つ）。
 */
export function EditorFrame({ initial, children }: { initial: FrameInitial; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrowNow, () => initial.initialNarrow);

  const [list, setList] = useState<ListState>({ pages: initial.pages, next: initial.next, opened: null });
  const [now, setNow] = useState(initial.now);
  const [collapsed, setCollapsed] = useState(false);
  // 狭い画面で一覧を出している path（path が変われば閉じる）
  const [listFor, setListFor] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [search, setSearch] = useState({ open: false, value: "" });
  // ⌘K で検索の入力欄へフォーカスを移す回数（開いていても移す）
  const [searchFocus, setSearchFocus] = useState(0);
  // 公開のシート（path が変われば閉じる）と、「公開はまだ使えません」の知らせ
  const [sheet, setSheet] = useState<FramePublishKind | null>(null);
  const [sheetPath, setSheetPath] = useState(pathname);
  if (sheetPath !== pathname) {
    setSheetPath(pathname);
    setSheet(null);
  }
  const [notice, setNotice] = useState(0);
  const hideNotice = useCallback(() => setNotice(0), []);
  const frameRoot = useRef<HTMLDivElement | null>(null);
  // ⌘N で移り始めた元の path（移り終わるまで二度は押さない）
  const newFrom = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const currentId = PAGE_PATH.exec(pathname)?.[1];
  const settings = SETTINGS_ROUTES.find((route) => pathname === route.path || pathname.startsWith(`${route.path}/`));
  const sidebarOpen = narrow ? pathname === "/" || listFor === pathname : !collapsed;

  // 続きを読む（1 回に 1 つ。失敗したら止め、次に末尾が見えたときにもう一度）
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const loading = useRef(false);
  const loadMore = useCallback(async (cursor: string) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const chunk = await listPagesRequest(cursor);
      setList((current) => {
        if (current.next !== cursor) return current;
        const known = new Set(current.pages.map((page) => page.id));
        return { ...current, pages: [...current.pages, ...chunk.pages.filter((page) => !known.has(page.id))], next: chunk.next };
      });
    } catch {
      // 次に末尾が見えたときにもう一度
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    const cursor = list.next;
    if (!sentinel || cursor === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore(cursor);
      },
      { root: sentinel.closest("nav"), rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, list.next, loadMore]);

  const api = useMemo<Omit<EditorFrameApi, "narrow">>(
    () => ({
      pageOpened: (page) => setList((current) => ({ ...current, opened: page })),
      pageTitleChanged: (id, title) =>
        setList((current) => ({
          ...current,
          pages: current.pages.map((page) => (page.id === id ? { ...page, title } : page)),
          opened: current.opened?.id === id ? { ...current.opened, title } : current.opened,
        })),
      pageSaved: (id) =>
        setList((current) => {
          const page = current.pages.find((item) => item.id === id) ?? (current.opened?.id === id ? current.opened : undefined);
          return page ? { ...current, pages: toTop(current.pages, { ...page, updatedAt: new Date().toISOString() }) } : current;
        }),
      pageCreated: (id, title) => {
        const at = new Date().toISOString();
        const page: PageSummary = { id, kind: "note", title, lang: "ja", parent: null, stepStatus: null, createdAt: at, updatedAt: at };
        setList((current) => ({ ...current, pages: toTop(current.pages, page) }));
      },
      openPublish: () => setSheet("publish"),
    }),
    [],
  );
  const frame = useMemo<EditorFrameApi>(() => ({ narrow, ...api }), [narrow, api]);

  const items = useMemo(() => arrangeSidebarItems(list.pages, { now, query: search.value }), [list.pages, now, search.value]);

  const select = (id: string) => {
    if (id === currentId) setListFor(null);
    else router.push(`/p/${id}`);
  };

  const pickNew = (kind: NewPageKind) => {
    setNewMenuOpen(false);
    router.push(kind === "recording" ? "/p/new?from=recording" : "/p/new");
  };

  const selectAccount = (item: string) => {
    setMeOpen(false);
    const route = SETTINGS_ROUTES.find((candidate) => candidate.item === item);
    if (route) {
      router.push(route.path);
      return;
    }
    if (item === "logout") {
      // 結果に関わらずログインの画面へ。この画面の状態（一覧など）を残さないよう、読み込み直す
      void fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
        .catch(() => undefined)
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 読み込み直すため
        .finally(() => window.location.assign("/auth/login"));
    }
  };

  const opened = currentId ? (list.pages.find((page) => page.id === currentId) ?? (list.opened?.id === currentId ? list.opened : undefined)) : undefined;
  const recordingStart = pathname === "/p/new" && searchParams.get("from") === "recording";
  const title = currentId ? (opened?.title ?? "") : recordingStart ? "録音から" : (settings?.title ?? "");

  // 公開のシートはページを開いている画面だけ（一覧・設定・新しいページ・録音からでは出さない）
  const sheetShown = currentId ? sheet : null;
  const openPublish = () => setSheet("publish");

  const openSearch = () => {
    if (sheetShown) return;
    if (narrow) setListFor(pathname);
    else setCollapsed(false);
    setSearch((current) => (current.open ? current : { open: true, value: "" }));
    setSearchFocus((count) => count + 1);
  };
  useEffect(() => {
    if (searchFocus === 0) return;
    const input = frameRoot.current?.querySelector<HTMLInputElement>('[role="search"] input');
    input?.focus();
    input?.select();
  }, [searchFocus]);
  useSearchShortcut(openSearch);

  useEffect(() => {
    newFrom.current = null;
  }, [pathname]);
  useShortcuts({
    newPage: () => {
      if (sheetShown) return false;
      // 新しいページを開いている（作っている）とき・⌘N で移っている最中は、二つ目を作らない
      if ((pathname === "/p/new" && !recordingStart) || newFrom.current === pathname) return;
      newFrom.current = pathname;
      pickNew("blank");
    },
    publish: () => {
      if (!currentId || (narrow && sidebarOpen)) return false;
      if (!sheetShown) openPublish();
    },
  });

  // 一覧をしまう: デスクトップでは列を閉じ、狭い画面ではページへ戻る（`/` では一覧がその画面なので出さない）
  const collapse = narrow ? (pathname === "/" ? undefined : () => setListFor(null)) : () => setCollapsed(true);

  return (
    <FrameContext.Provider value={frame}>
      <div ref={frameRoot} data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0 }}>
        <EditorShell
          sidebarOpen={sidebarOpen}
          railOpen={false}
          sidebar={
            <ShellSidebar
              items={items}
              currentId={currentId}
              onSelect={select}
              onCollapse={collapse}
              newMenu={{ open: newMenuOpen, onToggle: () => setNewMenuOpen((open) => !open), onClose: () => setNewMenuOpen(false), onPick: pickNew }}
              search={{
                open: search.open,
                value: search.value,
                onOpen: () => setSearch({ open: true, value: "" }),
                onClose: () => setSearch({ open: false, value: "" }),
                onChange: (value) => setSearch({ open: true, value }),
              }}
              listEnd={list.next !== null ? <div ref={setSentinel} aria-hidden="true" style={{ height: 1 }} /> : null}
              me={{
                ...initial.me,
                open: meOpen,
                current: settings !== undefined,
                items: shellAccountItems(0, settings?.item),
                onToggle: () => setMeOpen((open) => !open),
                onClose: () => setMeOpen(false),
                onSelect: selectAccount,
              }}
            />
          }
          header={
            <ShellHeader
              title={title}
              plain={settings !== undefined}
              showListButton={!sidebarOpen}
              onToggleList={() => (narrow ? setListFor(pathname) : setCollapsed(false))}
              publish={currentId ? { ...shellPublishButton({ pub: null, isArticle: opened?.kind === "article" }), onClick: openPublish } : null}
            />
          }
          overlay={
            <>
              {sheetShown && (
                <FramePublishSheet
                  kind={sheetShown}
                  onKind={setSheet}
                  onClose={() => setSheet(null)}
                  onUnavailable={() => {
                    setSheet(null);
                    setNotice((count) => count + 1);
                  }}
                  onDestinations={() => {
                    setSheet(null);
                    router.push("/destinations");
                  }}
                />
              )}
              <PublishNotice shown={notice} onHide={hideNotice} />
            </>
          }
        >
          {children}
        </EditorShell>
      </div>
    </FrameContext.Provider>
  );
}
