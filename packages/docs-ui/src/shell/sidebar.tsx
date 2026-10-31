import { useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import { NewPageMenu, type NewPageKind } from "./new-page-menu";
import type { ShellListItem, ShellMenuItem } from "./types";

export type ShellSidebarProps = {
  items: ShellListItem[];
  currentId?: string;
  onSelect?: (id: string) => void;
  /** ＋の右隣の「一覧をしまう」。 */
  onCollapse?: () => void;
  newMenu?: { open: boolean; onToggle: () => void; onClose: () => void; onPick: (kind: NewPageKind) => void };
  search?: { open: boolean; value: string; onOpen: () => void; onClose: () => void; onChange: (value: string) => void };
  /** 一覧の末尾（<ul> の直後、<nav> の中）に置くもの。段階読み込みの目印など。 */
  listEnd?: ReactNode;
  me: {
    name: string;
    caption: string;
    /** アバターの面に出す1文字（写真は持ち込まない）。 */
    initial: string;
    /** 未処理の招待の数。 */
    badge?: number;
    open: boolean;
    current?: boolean;
    items: ShellMenuItem[];
    onToggle: () => void;
    onClose: () => void;
    onSelect: (id: string) => void;
  };
};

/** 本人の行のメニュー（発信先／役割とつながり／設定／ログアウト）。current に id（dest / account / settings）を渡すと、その項目に現在地を示す。 */
export function shellAccountItems(pendingInvites = 0, current?: string): ShellMenuItem[] {
  const items: ShellMenuItem[] = [
    { id: "dest", label: "発信先", icon: "ship" },
    { id: "account", label: "役割とつながり", icon: "people", badge: pendingInvites > 0 ? String(pendingInvites) : undefined },
    { id: "settings", label: "設定", icon: "gear" },
    { id: "logout", label: "ログアウト", icon: "back" },
  ];
  return items.map((item) => (item.id === current ? { ...item, current: true } : item));
}

/**
 * 左の一覧。上は検索アイコンと＋（新しいページ）だけ。絞り込み（すべて／公開中／録音）は持たない。
 * 1行は題名と時刻。2行目は公開先・録音・作成中のときだけ。下は本人の行ひとつ。
 */
export function ShellSidebar({ items, currentId, onSelect, onCollapse, newMenu, search, listEnd, me }: ShellSidebarProps) {
  const newButton = useRef<HTMLButtonElement | null>(null);
  const meButton = useRef<HTMLButtonElement | null>(null);
  return (
    <aside className="es-sb" aria-label="ページ">
      <div className="es-sb-top">
        {search?.open ? (
          <div className="es-sb-find" role="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="ページを探す"
              aria-label="ページを探す"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") search.onClose();
              }}
              autoFocus
            />
            <button type="button" className="es-ib es-ib--sm" aria-label="やめる" onClick={search.onClose}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : (
          <>
            {search && (
              <button type="button" className="es-ib" aria-label="探す" title="探す ⌘K" onClick={search.onOpen}>
                <Icon name="search" />
              </button>
            )}
            {newMenu && (
              <span className="es-newwrap">
                <button
                  ref={newButton}
                  type="button"
                  className="es-newbtn"
                  aria-label="新しいページ"
                  title="新しいページ"
                  aria-haspopup="menu"
                  aria-expanded={newMenu.open}
                  onClick={newMenu.onToggle}
                >
                  <Icon name="plus" />
                </button>
                {newMenu.open && <NewPageMenu trigger={newButton} onPick={newMenu.onPick} onClose={newMenu.onClose} />}
              </span>
            )}
            {onCollapse && (
              <button type="button" className="es-ib" aria-label="一覧をしまう" title="一覧をしまう" onClick={onCollapse}>
                <Icon name="side" />
              </button>
            )}
          </>
        )}
      </div>
      <nav className="es-sb-list" aria-label="ページの一覧">
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`es-di${item.id === currentId ? " es-di--on" : ""}${item.child ? " es-di--child" : ""}${item.sub || item.busy ? "" : " es-di--one"}`}
                aria-current={item.id === currentId ? "page" : undefined}
                onClick={() => onSelect?.(item.id)}
              >
                <span className={`es-di-t${item.title ? "" : " es-di-t--untitled"}`}>{item.title || "無題"}</span>
                <span className="es-when">{item.when}</span>
                {(item.sub || item.busy) && (
                  <span className="es-di-sub">
                    {/* 手順が動いている行の回るマーク。状態の言葉は sub の文字が持つので、マークは支援技術から隠す */}
                    {item.busy && <i className="es-busy" aria-hidden="true" />}
                    {item.sub?.dest && <i className={`es-dest es-dest--${item.sub.dest}`} aria-hidden="true" />}
                    {item.sub?.text}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {listEnd}
      </nav>
      <div className="es-sb-foot">
        <button
          ref={meButton}
          type="button"
          className={`es-sb-me${me.open || me.current ? " es-sb-me--on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={me.open}
          onClick={me.onToggle}
        >
          <span className="es-av" aria-hidden="true">
            {me.initial}
          </span>
          <span className="es-sb-who">
            <b>{me.name}</b>
            <span>{me.caption}</span>
          </span>
          {me.badge ? (
            <em className="es-badge" aria-label={`未処理の招待 ${me.badge} 件`}>
              {me.badge}
            </em>
          ) : null}
          <span className="es-cv" aria-hidden="true">
            ▾
          </span>
        </button>
        {me.open && <ShellMenu label="アカウント" className="es-menu--up" items={me.items} trigger={meButton} onSelect={me.onSelect} onClose={me.onClose} />}
      </div>
    </aside>
  );
}
