import { useCallback, useEffect, useRef, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** 停止点の候補。押せないボタン（disabled）は飛ばす。 */
const ITEMS = "button:not(:disabled)";

/**
 * WAI-ARIA の toolbar の動き（roving tabindex）。#43。
 * - Tab の停止点は帯の中で 1 つだけ（tabindex=0 は 1 つ、ほかは -1）。Tab で入り、もう一度 Tab で出る。
 * - ← → で前後へ（端では反対の端へ回る）、Home・End で先頭・最後へ。Esc は持たない（帯は閉じるものではない）。
 * - 最後にフォーカスした項目を覚え、Tab で戻ってきたときはそこに入る（押した・クリックした項目も同じ）。
 * 項目は帯の中のボタン（DOM の順）。描き直しのたびに停止点を 1 つにそろえ直すので、ボタンが増減しても崩れない。
 * 返す ref・onKeyDown・onFocus を、帯（role="toolbar" の要素）に付ける。
 */
export function useRovingFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const current = useRef<HTMLElement | null>(null);

  const settle = useCallback((active: HTMLElement | null) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const stop = active && items.includes(active) ? active : (items[0] ?? null);
    current.current = stop;
    for (const item of items) item.tabIndex = item === stop ? 0 : -1;
  }, []);

  // 描き直しのたびに（依存なし）。React は tabIndex を props で持たないので、ここで付け直しても上書きされない
  useEffect(() => {
    settle(current.current);
  });

  const onFocus = useCallback(
    (event: ReactFocusEvent<T>) => {
      const target = event.target as HTMLElement;
      if (target !== ref.current && target.matches(ITEMS)) settle(target);
    },
    [settle],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<T>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
      const at = items.indexOf(event.target as HTMLElement);
      if (at < 0) return;
      const last = items.length - 1;
      const moves: Partial<Record<string, number>> = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last };
      const next = moves[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const target = items[next];
      if (!target) return;
      settle(target);
      target.focus();
    },
    [settle],
  );

  return { ref, onKeyDown, onFocus };
}
