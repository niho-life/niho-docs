import { useId, useState } from "react";
import { Icon } from "./icons";
import type { ShellStatusState } from "./types";

/**
 * 状態は丸ひとつ。言葉は置かず、ホバーとキーボードのフォーカスで吹き出しに出す。
 * 吹き出しの文は aria-live="polite" の中にあるので、保存・公開の状態が変わると読み上げられる。Esc で吹き出しだけ閉じる。
 */
export function StatusDot({ state, tip }: { state: ShellStatusState; tip: string }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  const showsLock = state === "private" || state === "stopped";
  return (
    <span className="es-st-wrap" aria-live="polite" aria-atomic="true" data-dismissed={dismissed ? "true" : undefined}>
      <span
        className={`es-st es-st--${state}`}
        tabIndex={0}
        role="img"
        aria-label="ページの状態"
        aria-describedby={id}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDismissed(true);
        }}
        onBlur={() => setDismissed(false)}
        onMouseLeave={() => setDismissed(false)}
      >
        {showsLock ? <Icon name="lock" /> : <i aria-hidden="true" />}
      </span>
      <span id={id} role="tooltip" className="es-st-tip">
        {tip}
      </span>
    </span>
  );
}
