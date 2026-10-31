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
  /**
   * フォルダ（フォルダ＝子を持てるふつうのページ）。`value` はいまの入れ先（上の段なら null）、`options` は入れられる
   * フォルダ。渡さなければ節を出さない（Mac の殻など、移動を持たない画面）。
   */
  folder?: {
    value: string | null;
    options: { id: string; title: string }[];
    /** 入れられなかったときの短い一言。 */
    note?: string;
    onPick: (parent: string | null) => void;
  };
  lang: ShellLang;
  onLang?: (lang: ShellLang) => void;
  /** 言語の下に出す短い一言（変えられなかったときなど）。無ければ出さない。 */
  langNote?: string;
  /** 著者。title（肩書）が空なら肩書の行を出さない。 */
  author: { name: string; title: string; initial: string };
  info: { label: string; value: string }[];
  /** 書き出し: Markdown を押した。 */
  onExportMarkdown?: () => void;
  /** 書き出し: Google ドキュメントを押した。渡さなければ Google ドキュメントのボタンを出さない。 */
  onExportGoogle?: () => void;
  /** 「ページを削除」を押した（確認は呼ぶ側）。渡さなければ削除の行を出さない。 */
  onDelete?: () => void;
};

/** 右のレールの「ページ設定」の中身。上のバーが状態を言うので、ここは「どこに・何が足りないか」だけを置く。 */
export function ShellPageSettings({ destination, category, related, folder, lang, onLang, langNote, author, info, onExportMarkdown, onExportGoogle, onDelete }: ShellPageSettingsProps) {
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
      {folder && (
        <section className="es-psfolder">
          <h3>フォルダ</h3>
          <select aria-label="フォルダ" value={folder.value ?? ""} onChange={(event) => folder.onPick(event.target.value === "" ? null : event.target.value)}>
            <option value="">フォルダに入れない</option>
            {folder.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title || "無題"}
              </option>
            ))}
          </select>
          {folder.note && (
            <p role="alert" className="es-upnote">
              {folder.note}
            </p>
          )}
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
        {langNote && (
          <p role="alert" className="es-upnote">
            {langNote}
          </p>
        )}
      </section>
      <section>
        <h3>著者</h3>
        <div className="es-me">
          <span className="es-av" aria-hidden="true">
            {author.initial}
          </span>
          <div>
            {author.name}
            {author.title && <small>{author.title}</small>}
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
        <button type="button" className="es-linkrow" onClick={onExportMarkdown}>
          <Icon name="doc" />
          Markdown
        </button>
        {onExportGoogle && (
          <button type="button" className="es-linkrow" onClick={onExportGoogle}>
            <Icon name="ext" />
            Google ドキュメント
          </button>
        )}
      </section>
      {onDelete && (
        <section>
          <button type="button" className="es-linkrow es-danger" onClick={onDelete}>
            <Icon name="trash" />
            ページを削除
          </button>
        </section>
      )}
    </div>
  );
}
