"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { PageSummary } from "@niho/editor-store";
import { ShellPageSettings, ShellRail, ShellRailSection } from "niho-docs-ui/shell";
import type { AttachedPage, PageText } from "@/lib/attached-page";
import { countText, pageInfoRows, type TextCounts } from "@/lib/page-info";

/** 本文を数え直すまでの待ち（打っているあいだは数えない）。 */
export const COUNT_DELAY_MS = 300;

/** 閉じているときの見出しの一言（公開の配線が無い間は、いつも「自分だけ」）。 */
export const RAIL_SUMMARY = "自分だけ";

type CountStore = { subscribe: (onChange: () => void) => () => void; get: () => TextCounts | null };

/** 本文の数（開いているあいだだけ読む。変わったら少し待ってから数え直す）。 */
function countStore(text: PageText | null): CountStore {
  let counts: TextCounts | null = null;
  return {
    get: () => {
      if (!text) return null;
      counts ??= countText(text.read());
      return counts;
    },
    subscribe: (onChange) => {
      if (!text) return () => undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = text.subscribe(() => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          counts = countText(text.read());
          onChange();
        }, COUNT_DELAY_MS);
      });
      return () => {
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
      };
    },
  };
}

const noCounts = () => null;

export type InfoPanelProps = {
  /** 一覧の行（作成・更新・種類。言語は、ページを読み込み終える前だけこれを使う）。 */
  summary: PageSummary;
  /** 開いているページ（下書きを読み終えて、操作できるとき）。読み込んでいる間は null（ボタンは押しても何もしない）。 */
  page: AttachedPage | null;
  author: { name: string; initial: string };
  /** 録音の長さ（秒。録音ページでない・分からなければ null）。 */
  recordingSec: number | null;
  /** 入れられるフォルダ（上の段のページ）。渡さなければ「フォルダ」の節を出さない。 */
  folders?: { id: string; title: string }[];
  /** フォルダへ入れられなかったときの一言。 */
  folderNote?: string | null;
  /** フォルダを選んだ（`null` は上の段へ出す）。 */
  onFolder?: (parent: string | null) => void;
  /** 「ページ設定」の節を開いているか（閉じると見出しに「自分だけ」）。 */
  open: boolean;
  onToggle: () => void;
  onExportMarkdown: () => void;
  onDelete: () => void;
};

/**
 * 情報パネル（右のレール。設計 §5.4 のうち今つなげるもの）。見た目は niho-docs-ui の ShellRail・ShellPageSettings。
 * - 公開: 発信先・カテゴリ・関連する体験・公開ボタンは出さない（公開の配線が無い間は、いつも「自分だけ」。節を閉じると見出しに出る）。
 * - フォルダ: フォルダ＝子を持てるふつうのページ。選ぶとそのフォルダへ入れ、「フォルダに入れない」で上の段へ出す
 *   （`PATCH /api/pages/{id}/parent`。本文・revision は変わらない）。入れられなかったときは下に一言。
 * - 言語: 変えるとページの言語を保存する（PageEditor の自動保存。届かなければ前の言語に戻り、言語の下に一言）。
 * - 著者: ログイン中の人の名前。肩書（NIHO の役割）はまだ取れないので出さない。
 * - ページ: 作成・更新（日付）・録音（録音ページの長さ）・文字数（ja は文字数・en は語数）。
 * - 書き出し: Markdown だけ（「…」の書き出しと同じ。Google ドキュメントは NIHO の API 待ち）。
 * - ページを削除: 「…」の削除と同じ確認のダイアログを開く。
 * 手順・「AIと作る」の節はまだ出さない。
 */
export function InfoPanel({ summary, page, author, recordingSec, folders, folderNote, onFolder, open, onToggle, onExportMarkdown, onDelete }: InfoPanelProps) {
  const text = page?.text ?? null;
  const store = useMemo(() => countStore(text), [text]);
  const counts = useSyncExternalStore(store.subscribe, store.get, noCounts);
  const lang = page?.lang ?? summary.lang;
  return (
    <ShellRail label="このページの設定">
      <ShellRailSection title="ページ設定" summary={RAIL_SUMMARY} open={open} onToggle={onToggle}>
        <ShellPageSettings
          folder={folders && onFolder ? { value: summary.parent, options: folders, note: folderNote ?? undefined, onPick: onFolder } : undefined}
          lang={lang}
          onLang={page?.setLang}
          langNote={page?.langNote ?? undefined}
          author={{ name: author.name, title: "", initial: author.initial }}
          info={pageInfoRows({ kind: summary.kind, lang, createdAt: summary.createdAt, updatedAt: summary.updatedAt, recordingSec, counts })}
          onExportMarkdown={onExportMarkdown}
          onDelete={onDelete}
        />
      </ShellRailSection>
    </ShellRail>
  );
}
