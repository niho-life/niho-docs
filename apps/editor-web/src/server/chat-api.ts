import { estimateTokenCostUsd } from "@niho/docs-core";
import {
  DEFAULT_EDITOR_SETTINGS,
  monthKeyJst,
  type AiMessage,
  type AiMessageChange,
  type AiUsageDelta,
  type AiUsageTotals,
  type Block,
  type ChatChangeInput,
  type ChatTurnInput,
  type ChatWorkspacePage,
  type CreatePageInput,
  type EditorSettings,
  type OwnerId,
  type Page,
  type PageVersionSummary,
  type RestoreResult,
  type SaveResult,
} from "@niho/editor-store";
import { blocksToMarkdown, markdownToBlocks } from "niho-docs-ui/page";
import type { AiComposeBackend } from "../ai/config";
import {
  MAX_CHAT_INPUT_CHARS,
  buildChatMessages,
  buildChatSystem,
  isChatToolName,
  runChatTurn,
  type ChatHistoryTurn,
  type ChatItem,
  type ChatRun,
} from "../ai/chat";
import type { AiUsageReport } from "../ai/model";
import type { AuthProvider } from "../auth/types";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseBlocks } from "./page-input";

/**
 * AI チャット（#38）。旧アプリ（NIHO docs）の「修正の会話」と同じ動き: **AI が道具でページを直接書き換える**。
 * 提案（ai-api.ts）は採用を待つが、こちらは依頼の中でページが変わる。安全のための約束:
 *
 * - 触れるのは「開いているページ・その親・そのサブページ」だけ（`listChatWorkspace`）。
 * - 書く前に必ず今の本文を版（`ai`）に残し、その版の番号を会話に書く → 人が「元に戻す」で戻せる。
 * - 月の上限は提案と同じ意味で働く（往復のたびに見て、上限以上ならモデルを呼ばずに止める）。
 * - 鍵・プロンプト・本文はログ・エラーに出さない。会話に残すのは作業の要約（道具・ページの名前・成否）だけ。
 */

export type ChatPagesStore = {
  getPage: (owner: OwnerId, id: string) => Promise<Page | null>;
  savePage: (owner: OwnerId, id: string, patch: { blocks: Block[] }, options: { baseRevision: number }) => Promise<SaveResult | null>;
  createVersion: (owner: OwnerId, id: string, reason: "ai") => Promise<PageVersionSummary | null>;
  createPage: (owner: OwnerId, input: CreatePageInput) => Promise<Page>;
  restoreVersion: (
    owner: OwnerId,
    id: string,
    version: number,
    options: { baseRevision: number; accept: (blocks: unknown) => Block[] | null },
  ) => Promise<RestoreResult | null>;
  deletePage: (owner: OwnerId, id: string) => Promise<"deleted" | "published" | null>;
};

export type ChatConversationStore = {
  workspace: (owner: OwnerId, pageId: string) => Promise<ChatWorkspacePage[] | null>;
  history: (owner: OwnerId, pageId: string, conversationId: string) => Promise<{ messages: AiMessage[] } | null>;
  append: (owner: OwnerId, input: ChatTurnInput) => Promise<{ conversation: { id: string }; result: AiMessage } | null>;
  changes: (owner: OwnerId, pageId: string, messageId: string) => Promise<AiMessageChange[] | null>;
  undone: (owner: OwnerId, messageId: string, pageIds: readonly string[]) => Promise<number>;
};

export type ChatUsageStore = {
  get: (owner: OwnerId, month: string) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta) => Promise<AiUsageTotals>;
};

export type ChatApiDeps = {
  auth: () => AuthProvider;
  store: () => ChatPagesStore | null;
  conversations: () => ChatConversationStore | null;
  usage: () => ChatUsageStore | null;
  /** 道具つきの往復ができるモデル（無効なら 503 `ai_unavailable`）。 */
  ai: () => AiComposeBackend | null;
  limitUsd: () => number | null;
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
};

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function usageDelta(backend: AiComposeBackend, usage: AiUsageReport): AiUsageDelta {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: usd === null ? 0 : count(Math.round(usd * 1e6)) };
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  return limitUsd !== null && totals.costMicroUsd >= Math.round(limitUsd * 1e6);
}

async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error("editor-web: request failed", { route, name });
    return errorResponse("internal");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** 本文の字数（Markdown にできない本文は 0）。 */
function charsOf(blocks: readonly Block[]): number {
  const markdown = blocksToMarkdown(blocks);
  return markdown.ok ? Array.from(markdown.markdown).length : 0;
}

/** 道具の結果の JSON（モデルが読む。短く、内部の情報を入れない）。 */
function toolJson(value: unknown): string {
  return JSON.stringify(value);
}

const PAGE_HAS_PARTS = "このページの本文には、文字だけにできないもの（画像・録音）が入っています。この会話では直せません。";

/**
 * 道具を実行する側。触れるのは作業場のページだけで、書いたページは `changes` に積む
 * （版は依頼の中で最初に書いたときのものを残す＝依頼の前の本文に戻せる）。
 */
function createToolRunner(deps: {
  store: ChatPagesStore;
  owner: OwnerId;
  workspace: ChatWorkspacePage[];
  changes: Map<string, ChatChangeInput & { title: string }>;
}) {
  const { store, owner } = deps;
  const find = (id: unknown) => (typeof id === "string" ? deps.workspace.find((page) => page.id === id) : undefined);

  return async (call: { name: string; input: unknown }) => {
    const input = isPlainObject(call.input) ? call.input : {};
    if (!isChatToolName(call.name)) return { ok: false, result: "その道具はありません。" };

    if (call.name === "list_pages") {
      const pages = deps.workspace.map((page) => ({ id: page.id, title: page.title || "（題名なし）", kind: page.kind, open: page.open, writable: true }));
      return { ok: true, result: toolJson({ pages }) };
    }

    if (call.name === "read_page") {
      const target = find(input.page_id);
      if (!target) return { ok: false, result: "そのページは、この会話では開けません。list_pages の id を使ってください。" };
      const page = await store.getPage(owner, target.id);
      if (!page) return { ok: false, result: "そのページはもうありません。", page: target.title };
      const markdown = blocksToMarkdown(page.blocks);
      if (!markdown.ok) return { ok: false, result: PAGE_HAS_PARTS, page: page.title };
      return { ok: true, result: toolJson({ id: page.id, title: page.title, markdown: markdown.markdown }), page: page.title };
    }

    if (call.name === "write_page") {
      const target = find(input.page_id);
      if (!target) return { ok: false, result: "そのページは、この会話では書けません。list_pages の id を使ってください。" };
      if (typeof input.markdown !== "string") return { ok: false, result: "markdown に本文の全体を渡してください。", page: target.title };
      const parsed = markdownToBlocks(input.markdown);
      if (!parsed.ok) return { ok: false, result: `本文を読めませんでした: ${parsed.reason}`, page: target.title };
      const blocks = parseBlocks(parsed.blocks);
      if (!blocks.ok) return { ok: false, result: "本文が大きすぎるか、保存できない形です。", page: target.title };
      const current = await store.getPage(owner, target.id);
      if (!current) return { ok: false, result: "そのページはもうありません。", page: target.title };
      const before = blocksToMarkdown(current.blocks);
      if (!before.ok) return { ok: false, result: PAGE_HAS_PARTS, page: current.title };
      // 書く前の本文を版に残す（人が元に戻せる）
      const version = await store.createVersion(owner, target.id, "ai");
      if (!version) return { ok: false, result: "そのページはもうありません。", page: current.title };
      const saved = await store.savePage(owner, target.id, { blocks: blocks.value }, { baseRevision: current.revision });
      if (!saved) return { ok: false, result: "そのページはもうありません。", page: current.title };
      if (saved.status !== "saved") return { ok: false, result: "別の画面で保存されたので書けませんでした。read_page で読み直してください。", page: current.title };
      const chars = Array.from(input.markdown).length;
      const delta = chars - Array.from(before.markdown).length;
      const existing = deps.changes.get(target.id);
      deps.changes.set(target.id, {
        pageId: target.id,
        title: current.title,
        change: existing?.change ?? "edited",
        // 版は依頼の中で最初に書いたときのもの（依頼の前の本文）
        version: existing?.version ?? version.version,
        revision: saved.page.revision,
        chars,
        delta: existing ? existing.delta + delta : delta,
      });
      return { ok: true, result: toolJson({ id: target.id, chars, delta }), page: current.title };
    }

    // create_page
    if (typeof input.title !== "string" || input.title.trim().length === 0) return { ok: false, result: "title にページの題名を渡してください。" };
    if (typeof input.markdown !== "string") return { ok: false, result: "markdown に本文の全体を渡してください。" };
    const parsed = markdownToBlocks(input.markdown);
    if (!parsed.ok) return { ok: false, result: `本文を読めませんでした: ${parsed.reason}` };
    const blocks = parseBlocks(parsed.blocks);
    if (!blocks.ok) return { ok: false, result: "本文が大きすぎるか、保存できない形です。" };
    const title = input.title.trim().slice(0, 200);
    const created = await store.createPage(owner, { title, blocks: blocks.value });
    const chars = Array.from(input.markdown).length;
    deps.changes.set(created.id, { pageId: created.id, title: created.title, change: "created", version: null, revision: created.revision, chars, delta: chars });
    // 作ったページも、その依頼の中では読み書きできる
    deps.workspace.push({ id: created.id, title: created.title, kind: created.kind, parent: created.parent, open: false });
    return { ok: true, result: toolJson({ id: created.id, title: created.title, chars }), page: created.title };
  };
}

type ChatInput = { text: string; conversationId: string | null };

function parseChatBody(body: unknown): { ok: true; value: ChatInput } | { ok: false } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["text", "conversationId"])) return { ok: false };
  if (typeof body.text !== "string") return { ok: false };
  const text = body.text.trim();
  const length = Array.from(text).length;
  if (length === 0 || length > MAX_CHAT_INPUT_CHARS || text.includes("\u0000")) return { ok: false };
  if (body.conversationId !== undefined && body.conversationId !== null && typeof body.conversationId !== "string") return { ok: false };
  return { ok: true, value: { text, conversationId: typeof body.conversationId === "string" ? body.conversationId : null } };
}

/** 会話の記録から、モデルに渡す過去のやりとり（人の指示と AI の返答だけ）。 */
function historyOf(messages: readonly AiMessage[]): ChatHistoryTurn[] {
  return messages.filter((message) => message.text.length > 0).map((message) => ({ role: message.role, text: message.text }));
}

/** 画面に出す作業の要約（道具の名前はそのまま、ページの名前は今の題名）。 */
function itemsOf(run: ChatRun): ChatItem[] {
  return run.items;
}

/**
 * POST /api/pages/{id}/ai/chat — AI チャットの 1 回の依頼。モデルが道具でページを読み書きし、
 * 書いた分は版に残る。会話には指示・作業の要約・返答・直したページが残る。
 * 上限以上ならモデルを呼ばずに 429。未認証は 401、他人のページ・無いページは同じ 404。
 */
export function runAiChat(request: Request, id: string, deps: ChatApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/chat";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    const usage = deps.usage();
    if (!store || !chats || !usage) return errorResponse("unavailable");
    const backend = deps.ai();
    if (!backend) return jsonResponse(503, { error: "ai_unavailable" });
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseChatBody(body.value);
    if (!input.ok) return errorResponse("bad_request");

    const owner = session.userId;
    const workspace = await chats.workspace(owner, id);
    if (!workspace) return notFoundResponse();
    const open = workspace.find((page) => page.open)!;
    const conversationId = input.value.conversationId;
    const past = conversationId === null ? null : await chats.history(owner, id, conversationId);
    if (conversationId !== null && !past) return notFoundResponse();

    const month = monthKeyJst(deps.now ? deps.now() : new Date());
    const limitUsd = deps.limitUsd();
    if (overLimit(await usage.get(owner, month), limitUsd)) return jsonResponse(429, { error: "quota_exceeded" });

    const settings = (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
    const changes = new Map<string, ChatChangeInput & { title: string }>();
    const run = await runChatTurn({
      client: backend.client,
      system: buildChatSystem({ glossary: settings.glossary, ...(settings.aiLang === "same" ? {} : { lang: settings.aiLang }) }),
      messages: buildChatMessages(historyOf(past?.messages ?? []), input.value.text, { id: open.id, title: open.title, kind: open.kind }),
      run: createToolRunner({ store, owner, workspace, changes }),
      // 往復のたびに上限を見る（会話が長くても 1 人 1 か月の上限は同じ意味で働く）
      beforeCall: async () => !overLimit(await usage.get(owner, month), limitUsd),
      onUsage: async (report) => {
        await usage.record(owner, month, usageDelta(backend, report));
      },
      signal: request.signal,
    });

    const written = [...changes.values()];
    const turn = await chats.append(owner, {
      pageId: id,
      conversationId,
      input: input.value.text,
      reply: run.reply,
      items: itemsOf(run),
      result: run.result,
      resultCode: run.code,
      changes: written.map((change) => ({
        pageId: change.pageId,
        change: change.change,
        version: change.version ?? null,
        revision: change.revision,
        chars: change.chars,
        delta: change.delta,
      })),
    });
    if (!turn) console.error("editor-web: chat turn not recorded", { route });
    // 開いているページが変わっていれば、画面に載せ替えるために今の本文を返す
    const page = written.some((change) => change.pageId === id) ? await store.getPage(owner, id) : null;
    const totals = await usage.get(owner, month);
    return jsonResponse(200, {
      conversation: turn ? { id: turn.conversation.id, messageId: turn.result.id } : null,
      message: turn
        ? turn.result
        : { id: null, role: "assistant", text: run.reply, items: run.items, result: run.result, resultCode: run.code, changes: [] },
      page,
      usage: {
        month,
        costUsd: totals.costMicroUsd / 1e6,
        limitUsd,
        nearLimit: limitUsd !== null && totals.costMicroUsd * 5 >= Math.round(limitUsd * 1e6) * 4,
      },
    });
  });
}

/**
 * POST /api/pages/{id}/ai/chat/{messageId}/undo — その依頼で書いた分を元に戻す。
 * 直したページは依頼の前の版に戻し、作ったページはゴミ箱へ入れる（30 日は戻せる）。
 * 既に戻したもの・人が後から直したページは、そのままにして結果に理由を出す。
 */
export function undoAiChat(request: Request, id: string, messageId: string, deps: ChatApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/chat/[messageId]/undo";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    if (!store || !chats) return errorResponse("unavailable");
    const owner = session.userId;
    const changes = await chats.changes(owner, id, messageId);
    if (!changes) return notFoundResponse();

    const undone: string[] = [];
    const kept: { pageId: string; reason: "gone" | "changed" | "published" }[] = [];
    for (const change of changes) {
      const now = await store.getPage(owner, change.pageId);
      // 依頼のあとに人が直したページは、そのままにする（人の直しを消さない）
      if (now && now.revision !== change.revision) {
        kept.push({ pageId: change.pageId, reason: "changed" });
        continue;
      }
      if (change.change === "created") {
        const deleted = await store.deletePage(owner, change.pageId);
        if (deleted === "deleted") undone.push(change.pageId);
        else kept.push({ pageId: change.pageId, reason: deleted === "published" ? "published" : "gone" });
        continue;
      }
      if (!now || change.version === null) {
        kept.push({ pageId: change.pageId, reason: "gone" });
        continue;
      }
      const restored = await store.restoreVersion(owner, change.pageId, change.version, {
        baseRevision: now.revision,
        accept: (blocks) => {
          const parsed = parseBlocks(blocks);
          return parsed.ok ? parsed.value : null;
        },
      });
      if (restored?.status === "restored") undone.push(change.pageId);
      else kept.push({ pageId: change.pageId, reason: "changed" });
    }
    if (undone.length > 0) await chats.undone(owner, messageId, undone);
    const page = undone.includes(id) ? await store.getPage(owner, id) : null;
    return jsonResponse(200, { undone, kept, page });
  });
}
