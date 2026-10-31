"use client";

import { useEffect, useRef, type RefObject } from "react";

/** 送っている間のボタン（disabled にするとフォーカスが外れるので、aria-disabled と見た目だけ）。 */
export const BUSY_STYLE = { opacity: 0.4, cursor: "progress" } as const;

/** シートの中の短い知らせ（読み込み中・コピーしました など。role="status" に使う。空なら高さを取らない）。 */
export const SHEET_STATUS_STYLE = { margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--ed-ink-sub)" } as const;

/** シートの中の説明の文。 */
export const SHEET_HELP_STYLE = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--ed-ink-sub)" } as const;

/**
 * シートの中身の段階（読み込み中 → 共有していない など）が替わったとき、押したボタンが消えてフォーカスが外れていたら
 * （body・ダイアログ自身・ダイアログの外）、その段階の主な要素（無ければダイアログ）へ移す。中の別の所を使っていれば動かさない。
 * pick が `force` を返したとき（確かめる段階へ入った・そこから戻った）は、どこにフォーカスがあっても移す。
 * 開いたときのフォーカスは ShellSheet が持つ（ここは最初の段階では何もしない）。
 */
export function useFocusOnPhase(
  phase: string,
  inside: RefObject<HTMLElement | null>,
  pick: () => HTMLElement | null | { element: HTMLElement | null; force: true },
): void {
  const previous = useRef(phase);
  const picker = useRef(pick);
  useEffect(() => {
    picker.current = pick;
  });
  useEffect(() => {
    if (previous.current === phase) return;
    previous.current = phase;
    const dialog = inside.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const picked = picker.current();
    const force = picked !== null && "force" in picked;
    const element = picked !== null && "force" in picked ? picked.element : picked;
    const active = document.activeElement;
    if (!force && active instanceof HTMLElement && active !== dialog && dialog.contains(active)) return;
    (element ?? dialog).focus();
  }, [phase, inside]);
}
