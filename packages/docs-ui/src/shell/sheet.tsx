import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export type ShellSheetProps = {
  /** ダイアログの名前（aria-label）。中身を替えるとき（公開 → 公開しました）はこれも替えると、フォーカスが中へ移り直す。 */
  label: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * 公開のシートの枠。デスクトップでは中央、900px 未満では下からのシート（スタイル側）。
 * role="dialog" aria-modal。開いたら中（data-autofocus の要素、なければダイアログ自身）へフォーカスし、
 * Esc・外（幕）の押下で閉じ、Tab は中で回り、閉じたら開く前の要素へフォーカスを戻す。
 * EditorShell の overlay に渡す（.es-root の中に出すため）。
 */
export function ShellSheet({ label, onClose, children }: ShellSheetProps) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // 開く前にフォーカスしていた要素を覚え、Esc で閉じ、閉じたら戻す
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 開いたとき、中身が替わったとき（label が替わったとき）に、中へフォーカスを移す
  useEffect(() => {
    const node = dialog.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus();
  }, [label]);

  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const node = dialog.current;
    const items = [...(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      node?.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="es-veil"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialog} className="es-sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>
        {children}
      </div>
    </div>
  );
}
