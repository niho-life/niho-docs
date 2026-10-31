"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EditorSitePage, type EditorDestinationMode } from "niho-docs-ui/shell";
import { disconnectSite, exportPath, loadSite, rotateSiteKey, updateSite, type IssuedKeyDto, type SiteDetailDto } from "@/lib/destinations-client";
import { DESTINATION_MESSAGES } from "@/publish/messages";

/**
 * 自分のサイト（`/destinations/{id}`。Issue #41）。画面は docs-ui の `EditorSitePage`（モック v6 の V.site）で、
 * ここは状態・確認・通信だけを持つ。
 *
 * 再発行した平文の鍵は、この component の state に 1 回だけ置く（「閉じる」で消える）。保存もログも URL も通さない。
 * 書き出しは `GET /api/destinations/{id}/export` をブラウザに開かせる（鍵は URL に入らない）。
 */

export type SiteViewProps = { id: string; initial: SiteDetailDto };

export function SiteView({ id, initial }: SiteViewProps) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState<{ host: string; path: string } | null>(null);
  const [confirmingKey, setConfirmingKey] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [issuedKey, setIssuedKey] = useState<IssuedKeyDto | null>(null);

  const { site, published } = detail;

  const reread = async () => {
    const result = await loadSite(id);
    if (result.ok) setDetail(result.value);
  };

  const copy = async (value: string, done: string) => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(value);
      setStatus(done);
    } catch {
      setStatus("コピーできませんでした。文字を選んで写してください");
    }
  };

  const save = async (patch: Parameters<typeof updateSite>[1], done: string) => {
    if (busy) return;
    setBusy(true);
    setStatus("");
    const result = await updateSite(id, patch);
    setBusy(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setDetail((current) => ({ ...current, site: result.value }));
    setUrlDraft(null);
    setStatus(done);
  };

  const rotate = async () => {
    if (busy) return;
    setBusy(true);
    setStatus("");
    const result = await rotateSiteKey(id);
    setBusy(false);
    setConfirmingKey(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setIssuedKey(result.value.key);
    setStatus(DESTINATION_MESSAGES.keyRotated);
    await reread();
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setStatus("");
    const result = await disconnectSite(id);
    setBusy(false);
    setConfirmingDisconnect(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    // 解除した接続はもう設定できない（一覧へ戻る）
    router.push("/destinations");
  };

  return (
    <EditorSitePage
      status={status}
      busy={busy}
      handle={site.handle}
      host={site.urlShape.host}
      path={site.urlShape.path}
      mode={site.mode}
      apiUrl={site.apiUrl}
      articleUrl={site.articleUrl}
      keys={site.keys.map((key) => ({ id: key.id, masked: key.masked, createdAt: key.createdAt, active: key.active }))}
      published={published.map((page) => ({ pageId: page.pageId, title: page.title, url: page.url, status: page.status }))}
      urlDraft={urlDraft}
      onBack={() => router.push("/destinations")}
      onCopyApi={() => void copy(site.apiUrl, "公開APIの URL をコピーしました")}
      onEditUrl={() => setUrlDraft({ host: site.urlShape.host, path: site.urlShape.path })}
      onUrlDraft={setUrlDraft}
      onCancelUrl={() => setUrlDraft(null)}
      onSaveUrl={() => {
        if (!urlDraft) return;
        void save({ urlShape: { host: urlDraft.host.trim(), path: urlDraft.path.trim().replace(/^\/+|\/+$/g, "") } }, "URL の形を保存しました");
      }}
      onMode={(mode: EditorDestinationMode) => void save({ mode }, mode === "api" ? "受け取り方を保存しました" : DESTINATION_MESSAGES.pushLater)}
      onExport={() => {
        setStatus("書き出しを始めました");
        window.location.assign(exportPath(id));
      }}
      confirmingKey={confirmingKey}
      onAskKey={() => setConfirmingKey(true)}
      onCancelKey={() => setConfirmingKey(false)}
      onRotateKey={() => void rotate()}
      issuedKey={issuedKey ? { masked: issuedKey.masked, plaintext: issuedKey.plaintext } : null}
      onCopyKey={() => void (issuedKey && copy(issuedKey.plaintext, "鍵をコピーしました"))}
      onCloseKey={() => {
        setIssuedKey(null);
        setStatus("");
      }}
      confirmingDisconnect={confirmingDisconnect}
      onAskDisconnect={() => setConfirmingDisconnect(true)}
      onCancelDisconnect={() => setConfirmingDisconnect(false)}
      onDisconnect={() => void disconnect()}
    />
  );
}
