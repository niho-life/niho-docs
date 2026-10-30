import { Icon } from "./icons";
import type { ShellDest, ShellLang } from "./types";

export type ShellPageSettingsProps = {
  /** 発信先。公開中は公開先と URL、予定は「に公開する予定」と足りないもの。 */
  destination?: {
    dest: ShellDest;
    label: string;
    url: string;
    planned?: boolean;
    updated?: boolean;
    /** 足りないもの（カバー写真・リード・カテゴリなど）。空なら「条件はそろっています」。 */
    missing?: { id: string; label: string }[];
    onChange?: () => void;
    onFix?: (id: string) => void;
  };
  category?: { options: string[]; value: string; onPick: (value: string) => void };
  /** NIHO Experience のときの、関連する体験（最大 3）。 */
  related?: { items: { id: string; title: string; by: string }[]; max?: number; onRemove?: (id: string) => void; onAdd?: () => void };
  lang: ShellLang;
  onLang?: (lang: ShellLang) => void;
  author: { name: string; title: string; initial: string };
  info: { label: string; value: string }[];
};

/** 右のレールの「ページ設定」の中身。上のバーが状態を言うので、ここは「どこに・何が足りないか」だけを置く。 */
export function ShellPageSettings({ destination, category, related, lang, onLang, author, info }: ShellPageSettingsProps) {
  return (
    <div className="es-ps">
      {destination && (
        <section>
          <h3>
            発信先
            <button type="button" onClick={destination.onChange}>
              変更
            </button>
          </h3>
          <div className={`es-pubcard es-pubcard--${destination.dest}${destination.planned ? " es-pubcard--planned" : ""}`}>
            <i aria-hidden="true" />
            <div>
              <b>{destination.planned ? `${destination.label} に公開する予定` : destination.label}</b>
              <code>{destination.url}</code>
            </div>
          </div>
          {destination.updated && <p className="es-upnote">直した内容はまだ読者に出ていません</p>}
          {destination.planned &&
            (destination.missing?.length ? (
              <ul className="es-todo">
                {destination.missing.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => destination.onFix?.(item.id)}>
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="es-upnote es-upnote--ok">条件はそろっています</p>
            ))}
        </section>
      )}
      {category && (
        <section>
          <h3>カテゴリ</h3>
          <div className="es-pills">
            {category.options.map((option) => (
              <button key={option} type="button" className={option === category.value ? "es-on" : undefined} aria-pressed={option === category.value} onClick={() => category.onPick(option)}>
                {option}
              </button>
            ))}
          </div>
        </section>
      )}
      {related && (
        <section>
          <h3>
            関連する体験
            <span>
              {related.items.length}/{related.max ?? 3}
            </span>
          </h3>
          <ul className="es-xps">
            {related.items.map((item) => (
              <li key={item.id} className="es-xp">
                <span className="es-xp-ph" aria-hidden="true" />
                <span>
                  {item.title}
                  <small>{item.by}</small>
                </span>
                <button type="button" aria-label={`${item.title} を外す`} onClick={() => related.onRemove?.(item.id)}>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="es-linkrow" onClick={related.onAdd}>
            <Icon name="plus" />
            体験を追加
          </button>
        </section>
      )}
      <section>
        <h3>言語</h3>
        <div className="es-pills">
          <button type="button" className={lang === "ja" ? "es-on" : undefined} aria-pressed={lang === "ja"} onClick={() => onLang?.("ja")}>
            日本語
          </button>
          <button type="button" className={lang === "en" ? "es-on" : undefined} aria-pressed={lang === "en"} onClick={() => onLang?.("en")}>
            English
          </button>
        </div>
      </section>
      <section>
        <h3>著者</h3>
        <div className="es-me">
          <span className="es-av" aria-hidden="true">
            {author.initial}
          </span>
          <div>
            {author.name}
            <small>{author.title}</small>
          </div>
        </div>
      </section>
      <section>
        <h3>ページ</h3>
        <dl className="es-kv">
          {info.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h3>書き出し</h3>
        <button type="button" className="es-linkrow">
          <Icon name="doc" />
          Markdown
        </button>
        <button type="button" className="es-linkrow">
          <Icon name="ext" />
          Google ドキュメント
        </button>
      </section>
    </div>
  );
}
