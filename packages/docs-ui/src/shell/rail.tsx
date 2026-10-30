import { useId, type ReactNode } from "react";
import { Icon } from "./icons";
import type { ShellIconName } from "./types";

/**
 * 右のレール。節は横の罫線で区切るだけ。上の節（手順・ページ設定）は押すと開閉し、下の「AIと作る」が残りの高さを使う
 * （最低 220px。開いている節は中でスクロールする）。
 */
export function ShellRail({ children, label = "このページの設定と AI" }: { children: ReactNode; label?: string }) {
  return (
    <aside id="es-rail" className="es-rail" aria-label={label}>
      {children}
    </aside>
  );
}

export type ShellRailSectionProps = {
  title: string;
  icon?: ShellIconName;
  /** 閉じているときだけ見出しの右に出す一言（例: 「自分だけ」）。 */
  summary?: string;
  /** 開閉できない節（「AIと作る」）は fill を付ける。残りの高さを使う。 */
  fill?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
};

export function ShellRailSection({ title, icon, summary, fill, open = true, onToggle, children }: ShellRailSectionProps) {
  const body = useId();
  const heading = (
    <>
      {icon && <Icon name={icon} />}
      {title}
    </>
  );
  return (
    <section className={`es-cd${open ? " es-cd--open" : ""}${fill ? " es-cd--fill" : ""}`}>
      <h3 className="es-ch-h">
        {fill || !onToggle ? (
          <span className="es-ch es-ch--static">{heading}</span>
        ) : (
          <button type="button" className="es-ch" aria-expanded={open} aria-controls={body} onClick={onToggle}>
            {heading}
            {!open && summary ? <span className="es-sum">{summary}</span> : null}
            <span className="es-cv" aria-hidden="true">
              ▾
            </span>
          </button>
        )}
      </h3>
      <div id={body} className="es-cb" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
