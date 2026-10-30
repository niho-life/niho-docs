import type { RefObject } from "react";
import { ShellMenu } from "./menu";
import type { ShellMenuItem } from "./types";

export type NewPageKind = "blank" | "recording";

const ITEMS: ShellMenuItem[] = [
  { id: "blank", label: "空のページ", icon: "doc" },
  { id: "recording", label: "録音から", icon: "mic" },
];

/** 「新しいページ」の＋を押すと出るメニュー。空のページ／録音から。 */
export function NewPageMenu({ onPick, onClose, trigger }: { onPick: (kind: NewPageKind) => void; onClose: () => void; trigger?: RefObject<HTMLElement | null> }) {
  return (
    <ShellMenu
      label="新しいページ"
      className="es-menu--narrow"
      items={ITEMS}
      trigger={trigger}
      onClose={onClose}
      onSelect={(id) => onPick(id === "recording" ? "recording" : "blank")}
    />
  );
}
