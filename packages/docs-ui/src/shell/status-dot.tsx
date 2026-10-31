import { useId, useState } from "react";
import { Icon } from "./icons";
import type { ShellStatusState } from "./types";

/** 丸を出す状態（公開中・限定公開・更新あり）。非公開と「公開をやめた」は出さない。 */
export function showsStatusDot(state: ShellStatusState): boolean {
  return state !== "private" && state !== "stopped";
}

/**
 * 状態は丸ひとつ。言葉は置かず、ホバーとキーボードのフォーカスで吹き出しに出す。
 * 吹き出しの文は aria-live="polite" の中にあるので、保存・公開の状態が変わると読み上げられる。Esc で吹き出しだけ閉じる。
 *
 * **出すのは公開しているあいだだけ**（地球のマーク）。非公開と「公開をやめた」は丸を出さない（公開ボタンの文言で分かる）。
 * そのときも、保存の状態を読み上げるために、同じ文を見えない live region として置く（見える文字は本文の上にある）。
 * 隠すのは `clip-path` だけ（`overflow: hidden` の 1px の箱にすると、横スクロールの検査が「横に出ている要素」として数える）。
 */
export function StatusDot({ state, tip }: { state: ShellStatusState; tip: string }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  if (!showsStatusDot(state)) {
    return (
      <span className="es-st-wrap es-st-wrap--quiet" aria-live="polite" aria-atomic="true">
        {tip}
      </span>
    );
  }
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
        <Icon name="globe" />
      </span>
      <span id={id} role="tooltip" className="es-st-tip">
        {tip}
      </span>
    </span>
  );
}
