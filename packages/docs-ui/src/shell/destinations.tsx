import { Icon } from "./icons";
import { ShellDestPill, ShellKv, ShellKvs, ShellSection, ShellSettingsPage, ShellTable, ShellToggle } from "./settings-parts";
import type { ShellDest } from "./types";

export type DestinationRow = {
  id: ShellDest;
  label: string;
  host: string;
  /** 例: guides/。 */
  path: string;
  /** 誰向けか（旅行者向け · 英語）。 */
  who: string;
  /** 出せる理由（ライター・NIHO アカウント・接続済み）。 */
  role: string;
  connected: boolean;
  /** その発信先に公開中のページの数。 */
  published: number;
};

export type DestinationsPageProps = {
  dests: DestinationRow[];
  /** 本人のサイトの「設定」。 */
  onOpenSite: () => void;
  onAdd: () => void;
};

/** 発信先（モック v6 の V.dest）。役割で出せる面・接続した本人のサイト・「発信先を追加」。 */
export function DestinationsPage({ dests, onOpenSite, onAdd }: DestinationsPageProps) {
  return (
    <ShellSettingsPage title="発信先">
      <ShellSection>
        <ul className="es-dl">
          {dests.map((dest) => (
            <li key={dest.id} className={`es-dcard es-dcard--${dest.id}`}>
              <i aria-hidden="true" />
              <div>
                <b>{dest.label}</b>
                <code>
                  {dest.host}/{dest.path}
                </code>
                <div className="es-dcard-m">
                  <span>{dest.who}</span>
                  {dest.connected ? <span className="es-tag-ok">✓ {dest.role}</span> : <span className="es-tag-no">未接続</span>}
                  <span>公開中 {dest.published}</span>
                </div>
              </div>
              {dest.id === "site" ? (
                <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label={`${dest.host} の設定`} onClick={onOpenSite}>
                  設定
                </button>
              ) : (
                <a className="es-btn es-btn--quiet es-btn--sm" href={`https://${dest.host}`} target="_blank" rel="noopener noreferrer">
                  {dest.host}
                  <Icon name="ext" />
                </a>
              )}
            </li>
          ))}
          <li>
            <button type="button" className="es-dcard es-dcard--add" onClick={onAdd}>
              <i aria-hidden="true" />
              <span>
                <b>発信先を追加</b>
                <code>自分のサイト · WordPress · Ghost</code>
              </span>
            </button>
          </li>
        </ul>
      </ShellSection>
    </ShellSettingsPage>
  );
}

export type SitePageProps = {
  /** 本人のサイトのホスト（見出しになる）。 */
  host: string;
  apiUrl: string;
  /** 伏せ字にした鍵（値は画面に戻らない）。 */
  maskedKey: string;
  wordpress: { on: boolean };
  /** 記事の URL の型（{slug} を含む）。 */
  articleUrl: string;
  published: { id: string; title: string; url: string }[];
  onBack: () => void;
  onCopyApi?: () => void;
  onReissueKey?: () => void;
  onWordpress?: (on: boolean) => void;
  onExport?: () => void;
  onDisconnect?: () => void;
};

/** 自分のサイト（モック v6 の V.site）。受け取り方（公開API・鍵・WordPress・書き出し）・URL・公開中の表・接続の解除。 */
export function SitePage(props: SitePageProps) {
  return (
    <ShellSettingsPage title={props.host} back={{ label: "発信先に戻る", onClick: props.onBack }} pill={<ShellDestPill dest="site" />}>
      <ShellSection title="受け取り方">
        <ShellKvs>
          <ShellKv label="公開API">
            <code>{props.apiUrl}</code>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="公開APIの URL をコピー" onClick={props.onCopyApi}>
              コピー
            </button>
          </ShellKv>
          <ShellKv label="鍵">
            <code>{props.maskedKey}</code>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="鍵を再発行" onClick={props.onReissueKey}>
              再発行
            </button>
          </ShellKv>
          <ShellKv label="WordPress に送る">
            <ShellToggle checked={props.wordpress.on} label="WordPress に送る" onChange={props.onWordpress} />
            <span className="es-kvs-note">{props.host}/wp-json</span>
          </ShellKv>
          <ShellKv label="書き出し">
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={props.onExport}>
              Markdown + 写真（zip）
            </button>
          </ShellKv>
        </ShellKvs>
      </ShellSection>
      <ShellSection title="URL">
        <ShellKvs>
          <ShellKv label="記事">
            <code>{props.articleUrl}</code>
          </ShellKv>
          <ShellKv label="写真">
            <span>公開のときに {props.host} へ複製</span>
          </ShellKv>
        </ShellKvs>
      </ShellSection>
      <ShellSection title="このサイトに公開中">
        <ShellTable
          label="このサイトに公開中のページ"
          columns={["ページ", "URL"]}
          hideHead
          rows={props.published.map((page) => ({
            id: page.id,
            cells: [
              <div key="t" className="es-tbl-t">
                <span className="es-tbl-ph" aria-hidden="true" />
                <b>{page.title}</b>
              </div>,
              <code key="u">{page.url}</code>,
            ],
          }))}
        />
      </ShellSection>
      <ShellSection>
        <button type="button" className="es-danger" onClick={props.onDisconnect}>
          接続を解除
        </button>
      </ShellSection>
    </ShellSettingsPage>
  );
}
