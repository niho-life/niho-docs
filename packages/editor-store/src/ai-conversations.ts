import type { PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { Database, OwnerId, Queryable } from "./types.ts";

/**
 * AI チャット（会話）の層（表 ai_conversations・ai_messages。migration 0022）。
 * 旧アプリ（packages/docs-core の conversation.ts）がファイルに持っていた会話を、サーバーの正本に置き換えたもの。
 *
 * - 会話はページに紐づき、読み書きはすべて owner とページで絞る（他人の会話・無いページはどちらも null＝同じ 404）。
 * - 1 回のやりとり（人の頼み → AI の提案）は 1 transaction で 2 つの発言として足す（途中の片方だけが残らない）。
 * - 採用は提案の発言に後から書く（採用した中身と、採用の前の本文が残った版の番号）。採用しなければ何も書かない。
 * - 持つのは頼んだことと提案の中身だけ（鍵・プロンプト・モデルへ送った文は持たない）。
 */

/** ページの会話の一覧で返す数の上限（新しい順）。 */
export const CONVERSATION_LIST_LIMIT = 50;
/** 1 つの会話で返す発言の数の上限（古い順。超えた分は新しいものだけを返す）。 */
export const CONVERSATION_MESSAGE_LIMIT = 200;
/** 発言の文の上限（文字。migration の CHECK と同じ）。 */
export const MESSAGE_TEXT_MAX_CHARS = 4_000;
/** 提案・採用の JSON の上限（バイト）。超えるものは保存しない（会話は手がかりで、本文の正本はページ）。 */
export const MESSAGE_JSON_MAX_BYTES = 256 * 1024;

const PRESET_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

export type AiMessageRole = "user" | "assistant";

export type AiConversationSummary = {
  id: string;
  pageId: string;
  createdAt: string;
  updatedAt: string;
  /** 発言の数（人の頼みと AI の返事の合計）。 */
  messages: number;
  /** 一覧に出す最後の発言の文（会話が空なら null）。 */
  lastText: string | null;
};

export type AiMessage = {
  id: string;
  seq: number;
  role: AiMessageRole;
  text: string;
  /** 候補から頼んだときの preset の id（自由入力は null）。 */
  preset: string | null;
  /** そのときの提案（AI の発言だけ）。 */
  proposal: unknown | null;
  /** 採用した中身（採用していなければ null）。 */
  adopted: unknown | null;
  /** 採用の前の本文が残った版の番号（採用していなければ null）。 */
  version: number | null;
  adoptedAt: string | null;
  createdAt: string;
};

export type AiConversation = { conversation: AiConversationSummary; messages: AiMessage[] };

/** 1 回のやりとり。`request` は人が頼んだこと、`result` は AI の結果の一言とそのときの提案。 */
export type AiTurnInput = {
  pageId: string;
  /** 続ける会話（無ければ新しい会話を始める）。他人の会話・このページでない会話は null を返す。 */
  conversationId?: string | null;
  request: { text: string; preset?: string | null };
  result: { text: string; proposal: unknown };
};

export type AiTurn = { conversation: AiConversationSummary; request: AiMessage; result: AiMessage };

function assertOwner(owner: OwnerId): void {
  // ai-usage.ts・store.ts と同じ守り（空の owner で誰のものでもない行を作らない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

/** 保存できる文（1〜MESSAGE_TEXT_MAX_CHARS 文字・NUL なし）。 */
export function isMessageText(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= MESSAGE_TEXT_MAX_CHARS;
}

/** 保存できる JSON（object で、MESSAGE_JSON_MAX_BYTES バイト以内・NUL なし）。 */
export function isMessageJson(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  if (text === undefined || text.includes("\\u0000")) return false;
  return new TextEncoder().encode(text).byteLength <= MESSAGE_JSON_MAX_BYTES;
}

type ConversationRow = { id: string; page_id: string; created_at: Date; updated_at: Date; messages: string | number; last_text: string | null };
type MessageRow = {
  id: string;
  seq: number;
  role: AiMessageRole;
  text: string;
  preset: string | null;
  proposal: unknown;
  adopted: unknown;
  version: number | null;
  adopted_at: Date | null;
  created_at: Date;
};

function toSummary(row: ConversationRow): AiConversationSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messages: Number(row.messages),
    lastText: row.last_text,
  };
}

function toMessage(row: MessageRow): AiMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    preset: row.preset,
    proposal: row.proposal ?? null,
    adopted: row.adopted ?? null,
    version: row.version,
    adoptedAt: row.adopted_at ? row.adopted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

const SUMMARY_SELECT = `SELECT c.id, c.page_id, c.created_at, c.updated_at,
         (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS messages,
         (SELECT m.text FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_text
    FROM ai_conversations c`;

const MESSAGE_SELECT = "SELECT id, seq, role, text, preset, proposal, adopted, version, adopted_at, created_at FROM ai_messages";

async function pageExists(db: Queryable, owner: OwnerId, pageId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, pageId]);
  return result.rows.length > 0;
}

/** ページの会話の一覧（新しい順）。ページが本人のものでない・無い・ゴミ箱の中なら null。 */
export async function listConversations(db: Queryable, owner: OwnerId, pageId: string): Promise<AiConversationSummary[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  if (!(await pageExists(db, owner, pageId))) return null;
  const result = await db.query<ConversationRow>(
    `${SUMMARY_SELECT} WHERE c.owner = $1 AND c.page_id = $2 ORDER BY c.updated_at DESC, c.id DESC LIMIT $3`,
    [owner, pageId, CONVERSATION_LIST_LIMIT],
  );
  return result.rows.map(toSummary);
}

/** 1 つの会話とその発言（古い順。CONVERSATION_MESSAGE_LIMIT を超えたら新しい方だけ）。本人のこのページの会話でなければ null。 */
export async function getConversation(db: Queryable, owner: OwnerId, pageId: string, conversationId: string): Promise<AiConversation | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(conversationId)) return null;
  const found = await db.query<ConversationRow>(`${SUMMARY_SELECT} WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3`, [owner, pageId, conversationId]);
  const row = found.rows[0];
  if (!row) return null;
  const messages = await db.query<MessageRow>(
    `SELECT * FROM (${MESSAGE_SELECT} WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2) AS recent ORDER BY seq`,
    [conversationId, CONVERSATION_MESSAGE_LIMIT],
  );
  return { conversation: toSummary(row), messages: messages.rows.map(toMessage) };
}

/** 本人のこのページの提案の発言（採用の前に確かめる）。無ければ null。 */
export async function getAssistantMessage(db: Queryable, owner: OwnerId, pageId: string, messageId: string): Promise<AiMessage | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(messageId)) return null;
  const result = await db.query<MessageRow>(
    `SELECT m.id, m.seq, m.role, m.text, m.preset, m.proposal, m.adopted, m.version, m.adopted_at, m.created_at
       FROM ai_messages m
      WHERE m.id = $3 AND m.role = 'assistant'
        AND EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = m.conversation_id AND c.owner = $1 AND c.page_id = $2)`,
    [owner, pageId, messageId],
  );
  const row = result.rows[0];
  return row ? toMessage(row) : null;
}

async function inTransaction<T>(db: Database, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/**
 * 1 回のやりとりを足す（人の頼み → AI の提案の 2 つの発言）。`conversationId` を渡せばその会話に続け、
 * 渡さなければ新しい会話を始める。ページが本人のものでない・無い、渡した会話がこのページのものでなければ null
 * （呼び出し側は 404。他人のものと無いものを見分けさせない）。
 */
export async function appendTurn(db: Database, owner: OwnerId, input: AiTurnInput): Promise<AiTurn | null> {
  assertOwner(owner);
  if (!isPageId(input.pageId)) return null;
  if (input.conversationId != null && !isPageId(input.conversationId)) return null;
  if (!isMessageText(input.request.text) || !isMessageText(input.result.text)) throw new TypeError("editor-store: message text must be 1..4000 characters");
  const preset = input.request.preset ?? null;
  if (preset !== null && (typeof preset !== "string" || !PRESET_PATTERN.test(preset))) throw new TypeError("editor-store: preset must be a short id");
  if (!isMessageJson(input.result.proposal)) throw new TypeError("editor-store: proposal must be a small JSON object");

  return inTransaction(db, async (client) => {
    // ページを押さえてから書く（書き終えるまで削除させない）
    const page = await client.query<{ id: string }>("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE", [owner, input.pageId]);
    if (page.rows.length === 0) return null;

    let conversationId: string;
    if (input.conversationId == null) {
      const created = await client.query<{ id: string }>("INSERT INTO ai_conversations (owner, page_id) VALUES ($1, $2) RETURNING id", [owner, input.pageId]);
      conversationId = created.rows[0]!.id;
    } else {
      // 同じ会話に同時に足しても seq がぶつからないよう、会話の行を押さえる
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM ai_conversations WHERE owner = $1 AND page_id = $2 AND id = $3 FOR UPDATE",
        [owner, input.pageId, input.conversationId],
      );
      if (existing.rows.length === 0) return null;
      conversationId = existing.rows[0]!.id;
    }

    const next = await client.query<{ seq: number }>("SELECT coalesce(max(seq), 0) + 1 AS seq FROM ai_messages WHERE conversation_id = $1", [conversationId]);
    const seq = next.rows[0]!.seq;
    const request = await client.query<MessageRow>(
      `INSERT INTO ai_messages (conversation_id, seq, role, text, preset) VALUES ($1, $2, 'user', $3, $4)
       RETURNING id, seq, role, text, preset, proposal, adopted, version, adopted_at, created_at`,
      [conversationId, seq, input.request.text, preset],
    );
    const result = await client.query<MessageRow>(
      `INSERT INTO ai_messages (conversation_id, seq, role, text, proposal) VALUES ($1, $2, 'assistant', $3, $4::jsonb)
       RETURNING id, seq, role, text, preset, proposal, adopted, version, adopted_at, created_at`,
      [conversationId, seq + 1, input.result.text, JSON.stringify(input.result.proposal)],
    );
    const summary = await client.query<ConversationRow>(
      `UPDATE ai_conversations SET updated_at = clock_timestamp() WHERE id = $1
       RETURNING id, page_id, created_at, updated_at,
                 (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = ai_conversations.id) AS messages,
                 (SELECT m.text FROM ai_messages m WHERE m.conversation_id = ai_conversations.id ORDER BY m.seq DESC LIMIT 1) AS last_text`,
      [conversationId],
    );
    return { conversation: toSummary(summary.rows[0]!), request: toMessage(request.rows[0]!), result: toMessage(result.rows[0]!) };
  });
}

export type AdoptionInput = {
  pageId: string;
  /** 採用した提案の発言。 */
  messageId: string;
  /** 採用の前の本文が残った版の番号。 */
  version: number;
  /** 採用した中身（{ changes, inserts }）。 */
  adopted: unknown;
};

/**
 * 採用を提案の発言に書く（採用した中身・版の番号・時刻）。本人のこのページの提案の発言で、まだ採用を書いていないものだけ。
 * 書けなければ false（ページの保存そのものは済んでいるので、呼び出し側は 200 のまま続ける）。
 */
export async function recordAdoption(db: Queryable, owner: OwnerId, input: AdoptionInput): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(input.pageId) || !isPageId(input.messageId)) return false;
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new RangeError("editor-store: version must be a positive integer");
  if (!isMessageJson(input.adopted)) throw new TypeError("editor-store: adopted must be a small JSON object");
  const result = await db.query(
    `UPDATE ai_messages AS m
        SET adopted = $4::jsonb, version = $5, adopted_at = clock_timestamp()
      WHERE m.id = $3 AND m.role = 'assistant' AND m.proposal IS NOT NULL AND m.adopted IS NULL
        AND EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = m.conversation_id AND c.owner = $1 AND c.page_id = $2)`,
    [owner, input.pageId, input.messageId, JSON.stringify(input.adopted), input.version],
  );
  return (result.rowCount ?? 0) > 0;
}
