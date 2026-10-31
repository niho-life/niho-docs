import { UNTITLED_DOC } from "@niho/docs-core";
import { errorMessage, isCommandError, type DocsHost } from "niho-docs-ui/host/DocsHost";
import { blocksToMarkdown, markdownToBlocks, type Block } from "niho-docs-ui/page";

/**
 * 新しい editor の画面（#45 第 1 段）が使うページの口。
 *
 * 正本は Cloud SQL ではなく、**この Mac の保管庫の既存の口**（`apps/docs/src/lib/bridge.ts` → Rust の
 * `load_pages` / `create_page` / `open_page_document` / `save_opened_document`）。editor にフォルダは無いので、
 * フォルダの外の空間（`projectId: null`。保存先直下の `pages.json` と `pages/<id>.md`）だけを使う。
 * 旧い画面のフォルダには触らない（移行は #45 第 2 段）。
 *
 * 本文は保管庫では Markdown で、エディタでは限定 AST（blocks）なので、`niho-docs-ui/page` の往復を通す。
 * 限定 AST の外の要素があるページは**開かずに断る**（黙って欠けさせない。移行の対応表 §4）。
 * 保存は旧い画面と同じ handle 方式なので、同期の gate と「別の所で変わった」の検出がそのまま効く。
 */

/** 一覧の 1 行（本文は持たない）。 */
export type VaultPage = {
  id: string;
  title: string;
  createdAt: string;
  /** 本文のファイルの更新時刻（ミリ秒。まだ書いていなければ 0）。 */
  updatedMs: number;
};

export type OpenedPage = { ok: true; handle: string; blocks: Block[] } | { ok: false; problem: string };
export type SavedPage = { ok: true } | { ok: false; problem: string };

export type VaultPages = {
  list: () => Promise<VaultPage[]>;
  create: (createdAt: string) => Promise<VaultPage>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  open: (id: string) => Promise<OpenedPage>;
  save: (handle: string, blocks: readonly Block[]) => Promise<SavedPage>;
  release: (handle: string) => Promise<void>;
};

/** 新しいページの題名（保管庫には旧い画面と同じ「無題」で入れる。一覧は空の題名も薄く「無題」と出す）。 */
export const NEW_PAGE_TITLE = UNTITLED_DOC;

/** 保存を断られた理由のうち、言葉を変えて出すもの（旧い画面と同じ code）。 */
function saveProblem(error: unknown): string {
  if (isCommandError(error)) {
    if (error.code === "store_stale_document") return "このページは別の所で変わりました。読み直してください";
    if (error.code === "store_context_changed") return "保存先が変わりました。読み直してください";
  }
  return errorMessage(error, "保存できませんでした");
}

export function vaultPages(bridge: DocsHost): VaultPages {
  return {
    async list() {
      const loaded = await bridge.loadPages(null);
      const updated = new Map(loaded.docs.map((doc) => [doc.id, doc.updatedMs]));
      return loaded.pages
        .filter((page) => page.kind === "doc")
        .map((page) => ({ id: page.id, title: page.title, createdAt: page.createdAt, updatedMs: updated.get(page.id) ?? 0 }))
        // 更新順（本文を書いていないページは作った順で下に）
        .sort((left, right) => right.updatedMs - left.updatedMs || Date.parse(right.createdAt) - Date.parse(left.createdAt));
    },

    async create(createdAt) {
      const entry = await bridge.createPage(null, { kind: "doc", title: NEW_PAGE_TITLE, createdAt });
      return { id: entry.id, title: entry.title, createdAt: entry.createdAt, updatedMs: 0 };
    },

    rename(id, title) {
      return bridge.renamePage(null, id, title);
    },

    remove(id) {
      return bridge.deletePage(null, id);
    },

    async open(id) {
      let opened;
      try {
        opened = await bridge.openPageDocument(null, id);
      } catch (error) {
        return { ok: false, problem: errorMessage(error, "ページを開けませんでした") };
      }
      const parsed = markdownToBlocks(opened.markdown);
      if (!parsed.ok) {
        // 開かないので handle は返す（保護を掛けたままにしない）
        await bridge.releaseOpenedDocument(opened.handle).catch(() => undefined);
        return { ok: false, problem: "このページには、この本文のエディタで開けない要素があります（旧い画面で開いてください）" };
      }
      return { ok: true, handle: opened.handle, blocks: parsed.blocks };
    },

    async save(handle, blocks) {
      const markdown = blocksToMarkdown(blocks);
      if (!markdown.ok) return { ok: false, problem: "この本文は Markdown にできないので保存しませんでした" };
      try {
        await bridge.saveOpenedDocument(handle, markdown.markdown);
        return { ok: true };
      } catch (error) {
        return { ok: false, problem: saveProblem(error) };
      }
    },

    async release(handle) {
      await bridge.releaseOpenedDocument(handle).catch(() => undefined);
    },
  };
}
