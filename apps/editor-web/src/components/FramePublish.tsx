"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { PublishSheet, type PublishDestOption, type PublishExtras, type PublishRange, type ShellDest } from "niho-docs-ui/shell";

/** 公開の実行（#39・#40）が入るまで、シートの確定で知らせる文言。 */
export const PUBLISH_NOTICE_TEXT = "公開はまだ使えません";
/** 「公開はまだ使えません」を出しておく長さ（AI の提案の知らせと同じ）。 */
export const PUBLISH_NOTICE_MS = 4000;

export type FramePublishKind = "publish" | "addDest";

/**
 * 公開のシートの発信先（仮）。発信先の接続と役割の読み込み（#39・#40・#42）が入るまで、どれも接続できていない状態で見せる。
 * 実際と違う「出せる」「条件はそろっています」は出さない（選べず、公開は押せない）。設計 §8.1・§10 の NIHO が運営する 2 つと、本人のサイト。
 */
const DRAFT_DESTS: PublishDestOption[] = [
  { id: "exp", label: "NIHO Experience", who: "旅行者向け · 英語", url: "接続すると選べます", role: "", connected: false },
  { id: "niho", label: "NIHO", who: "鎌倉の人向け", url: "接続すると選べます", role: "", connected: false },
  { id: "site", label: "自分のサイト", who: "本人のサイト", url: "接続すると選べます", role: "", connected: false },
];

/**
 * 枠の公開のシート（docs-ui の PublishSheet。EditorShell の overlay に置く）。選んだ発信先・範囲・あわせては開いているあいだだけ持つ。
 * 発信先はどれも未接続なので選べず、確定（公開する）は押せない。押せるようになったときの受け皿として、確定は onUnavailable で「まだ使えません」と知らせるだけ。発信先を追加・接続するは発信先の設定へ。
 */
export function FramePublishSheet(props: { kind: FramePublishKind; onKind: (kind: FramePublishKind) => void; onClose: () => void; onUnavailable: () => void; onDestinations: () => void }) {
  const [picked, setPicked] = useState<ShellDest | undefined>(undefined);
  const [range, setRange] = useState<PublishRange>("live");
  const [extras, setExtras] = useState<PublishExtras>({ app: false, news: false, xp: false });
  if (props.kind === "addDest") return <PublishSheet kind="addDest" onPick={props.onDestinations} onClose={props.onClose} />;
  return (
    <PublishSheet
      kind="publish"
      dests={DRAFT_DESTS}
      picked={picked}
      missing={[]}
      range={range}
      extras={extras}
      onPick={setPicked}
      onConnect={props.onDestinations}
      onAddDest={() => props.onKind("addDest")}
      onRange={setRange}
      onExtra={(key) => setExtras((current) => ({ ...current, [key]: !current[key] }))}
      onFix={() => undefined}
      onPublish={props.onUnavailable}
      onClose={props.onClose}
    />
  );
}

/** 知らせの位置だけ（見た目は中の .es-card）。シートの幕（z-index 60）より下で、押す操作は邪魔しない。 */
const NOTICE_STYLE: CSSProperties = {
  position: "absolute",
  left: 16,
  right: 16,
  bottom: 24,
  zIndex: 50,
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none",
};

/**
 * 「公開はまだ使えません」の知らせ（aria-live）。入れ物はいつも置き、shown が替わるたびに PUBLISH_NOTICE_MS だけ文言を出す。
 * シートを閉じてから出す（開いているあいだ、シートの外は inert で読み上げられない）。
 */
export function PublishNotice({ shown, onHide }: { shown: number; onHide: () => void }) {
  useEffect(() => {
    if (shown === 0) return;
    const timer = window.setTimeout(onHide, PUBLISH_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [shown, onHide]);
  return (
    <div role="status" aria-live="polite" data-publish-notice="" style={NOTICE_STYLE}>
      {shown !== 0 && <p className="es-card">{PUBLISH_NOTICE_TEXT}</p>}
    </div>
  );
}
