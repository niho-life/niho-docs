import { useState } from "react";
import { PublishSheet, type PublishDestOption, type PublishExtras, type PublishRange, type ShellDest } from "../src/shell";
import { DEST, extrasOf, isPublished, missingFor, urlOf, type GalleryPage } from "./data";
import { navigate } from "./shared";

export type SheetKind = "publish" | "done" | "addDest";

/** 公開のシートの状態（モックの S.sheet / S.pick / S.range / extra）。状態はここ（呼ぶ側）が持ち、部品は props で描く。 */
export function PublishFlow({
  page,
  kind: initialKind,
  pick: initialPick,
  conn = true,
  onClose,
  onFix,
  onPublished,
  onUnpublish,
}: {
  page: GalleryPage;
  kind: SheetKind;
  pick?: ShellDest;
  /** 本人のサイトを接続しているか（false なら「接続する ›」）。 */
  conn?: boolean;
  onClose: () => void;
  onFix: (id: string) => void;
  onPublished: (dest: ShellDest, range: PublishRange) => void;
  onUnpublish: () => void;
}) {
  const [kind, setKind] = useState<SheetKind>(initialKind);
  const [pick, setPick] = useState<ShellDest | undefined>(initialPick);
  const [range, setRange] = useState<PublishRange>(page.pub?.range === "unlisted" ? "unlisted" : "live");
  const [extras, setExtras] = useState<PublishExtras>(() => extrasOf(page));
  const [done, setDone] = useState<ShellDest>(page.pub && isPublished(page) ? page.pub.dest : "exp");

  if (kind === "done") {
    return (
      <PublishSheet
        kind="done"
        host={DEST[done].host}
        url={urlOf(page, done)}
        onView={() => navigate(`preview:${page.id}`)}
        onCopy={() => {
          void navigator.clipboard?.writeText(urlOf(page, done)).catch(() => undefined);
        }}
        onClose={onClose}
      />
    );
  }
  if (kind === "addDest") {
    return <PublishSheet kind="addDest" onPick={() => navigate("site")} onClose={onClose} />;
  }
  const cur = isPublished(page) && page.pub ? page.pub : null;
  const to = pick ?? cur?.dest;
  const dests: PublishDestOption[] = (Object.keys(DEST) as ShellDest[]).map((id) => ({
    id,
    label: DEST[id].label,
    who: DEST[id].who,
    url: urlOf(page, id),
    role: DEST[id].role,
    connected: id !== "site" || conn,
  }));
  return (
    <PublishSheet
      kind="publish"
      current={cur ? { updated: cur.updated } : null}
      dests={dests}
      picked={to}
      missing={to ? missingFor(page, to) : []}
      range={range}
      extras={extras}
      onPick={setPick}
      onConnect={() => navigate("site")}
      onAddDest={() => setKind("addDest")}
      onRange={setRange}
      onExtra={(key) => setExtras((current) => ({ ...current, [key]: !current[key] }))}
      onFix={onFix}
      onPublish={() => {
        if (!to) return;
        setDone(to);
        onPublished(to, to === "site" ? "live" : range);
        setKind("done");
      }}
      onUnpublish={onUnpublish}
      onClose={onClose}
    />
  );
}
