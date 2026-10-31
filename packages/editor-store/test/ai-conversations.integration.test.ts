import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import {
  CONVERSATION_MESSAGE_LIMIT,
  MESSAGE_JSON_MAX_BYTES,
  appendTurn,
  getAssistantMessage,
  getConversation,
  listConversations,
  recordAdoption,
  type AiTurnInput,
} from "../src/ai-conversations.ts";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・文だけを使う（実在の人・実際の会話を入れない）
const OWNER = "synthetic-chat-owner-a";
const OTHER = "synthetic-chat-owner-b";

const proposal = {
  label: "整える",
  baseRevision: 1,
  changes: [{ index: 0, before: "合成のまえ", after: "合成のあと", parts: [{ ins: "合成のあと" }] }],
  inserts: [],
  unchanged: 1,
};

function turn(pageId: string, extra: Partial<AiTurnInput> = {}): AiTurnInput {
  return {
    pageId,
    request: { text: "整える", preset: "tidy" },
    result: { text: "提案が 1 件あります", proposal },
    ...extra,
  };
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

describe("AI conversations", { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set" }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let store: EditorStore;

  before(async () => {
    ({ pool, drop } = await withSchema("chat"));
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await drop();
  });

  const newPage = async (owner = OWNER): Promise<string> => {
    const page = await store.createPage(owner, { title: "合成のページ", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成のまえ" }] }] });
    return page.id;
  };

  it("starts a conversation on the first turn and keeps the two messages in order", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first);
    assert.equal(first.request.role, "user");
    assert.equal(first.request.text, "整える");
    assert.equal(first.request.preset, "tidy");
    assert.equal(first.result.role, "assistant");
    assert.deepEqual(first.result.proposal, proposal);
    assert.equal(first.result.preset, null);
    assert.equal(first.request.seq, 1);
    assert.equal(first.result.seq, 2);
    assert.equal(first.conversation.messages, 2);
    assert.equal(first.conversation.lastText, "提案が 1 件あります");

    const second = await appendTurn(pool, OWNER, turn(pageId, { conversationId: first.conversation.id, request: { text: "もっと短く" } }));
    assert.ok(second);
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(second.request.seq, 3);
    assert.equal(second.request.preset, null);
    assert.equal(second.conversation.messages, 4);

    const opened = await getConversation(pool, OWNER, pageId, first.conversation.id);
    assert.ok(opened);
    assert.deepEqual(
      opened.messages.map((message) => [message.seq, message.role, message.text]),
      [
        [1, "user", "整える"],
        [2, "assistant", "提案が 1 件あります"],
        [3, "user", "もっと短く"],
        [4, "assistant", "提案が 1 件あります"],
      ],
    );
  });

  it("answers only the owner's own conversations (another owner and a missing page are both null)", async () => {
    const pageId = await newPage();
    const mine = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(mine);

    // 他人のページには足せない・読めない（無いページと同じ null）
    assert.equal(await appendTurn(pool, OTHER, turn(pageId)), null);
    assert.equal(await appendTurn(pool, OWNER, turn(randomUUID())), null);
    assert.equal(await getConversation(pool, OTHER, pageId, mine.conversation.id), null);
    assert.equal(await listConversations(pool, OTHER, pageId), null);
    assert.equal(await listConversations(pool, OWNER, randomUUID()), null);
    assert.equal(await getAssistantMessage(pool, OTHER, pageId, mine.result.id), null);

    // 他人の会話の id を自分のページに持ち込んでも続けられない
    const theirPage = await newPage(OTHER);
    const theirs = await appendTurn(pool, OTHER, turn(theirPage));
    assert.ok(theirs);
    assert.equal(await appendTurn(pool, OWNER, turn(pageId, { conversationId: theirs.conversation.id })), null);
    // 自分の別のページの会話も、このページの会話ではない
    const otherPageOfMine = await newPage();
    assert.equal(await appendTurn(pool, OWNER, turn(otherPageOfMine, { conversationId: mine.conversation.id })), null);
  });

  it("lists the conversations of one page, newest first", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    const second = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first && second);
    const list = await listConversations(pool, OWNER, pageId);
    assert.deepEqual(list?.map((item) => item.id), [second.conversation.id, first.conversation.id]);
    assert.equal(list?.[0]?.pageId, pageId);
    assert.equal(list?.[0]?.messages, 2);
  });

  it("writes the adoption on the proposal that was adopted, once", async () => {
    const pageId = await newPage();
    const added = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(added);
    const adopted = { changes: [{ index: 0, text: "合成のあと" }], inserts: [] };
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: added.result.id, version: 3, adopted }), true);

    const message = await getAssistantMessage(pool, OWNER, pageId, added.result.id);
    assert.deepEqual(message?.adopted, adopted);
    assert.equal(message?.version, 3);
    assert.ok(message?.adoptedAt);

    // 2 回目は書かない（採用は 1 度だけ）
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: added.result.id, version: 4, adopted }), false);
    assert.equal((await getAssistantMessage(pool, OWNER, pageId, added.result.id))?.version, 3);

    // 他人は書けない。人の発言にも書けない
    const other = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(other);
    assert.equal(await recordAdoption(pool, OTHER, { pageId, messageId: other.result.id, version: 1, adopted }), false);
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: other.request.id, version: 1, adopted }), false);
    assert.equal((await getAssistantMessage(pool, OWNER, pageId, other.result.id))?.adopted, null);
  });

  it("refuses text and JSON that are too big, before writing", async () => {
    const pageId = await newPage();
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "あ".repeat(4_001) } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "a\u0000b" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "整える", preset: "not a preset" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { result: { text: "x", proposal: "not an object" } })), TypeError);
    const huge = { label: "x", big: "あ".repeat(MESSAGE_JSON_MAX_BYTES) };
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { result: { text: "x", proposal: huge } })), TypeError);
    assert.deepEqual(await listConversations(pool, OWNER, pageId), []);
  });

  it("returns the newest messages when a conversation is longer than the limit", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first);
    const id = first.conversation.id;
    const turns = CONVERSATION_MESSAGE_LIMIT / 2 + 3;
    for (let index = 1; index < turns; index++) {
      await appendTurn(pool, OWNER, turn(pageId, { conversationId: id, request: { text: `${index} 回目` } }));
    }
    const opened = await getConversation(pool, OWNER, pageId, id);
    assert.equal(opened?.messages.length, CONVERSATION_MESSAGE_LIMIT);
    assert.equal(opened?.conversation.messages, turns * 2);
    // 古い方が落ちて、並びは古い順のまま
    assert.equal(opened?.messages[0]?.seq, turns * 2 - CONVERSATION_MESSAGE_LIMIT + 1);
    assert.equal(opened?.messages.at(-1)?.seq, turns * 2);
  });

  it("goes away with the page it belongs to (the trash purge is not blocked)", async () => {
    const pageId = await newPage();
    const added = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(added);
    assert.ok(await store.deletePage(OWNER, pageId));
    // ゴミ箱の中のページの会話は読めない
    assert.equal(await listConversations(pool, OWNER, pageId), null);
    // 保持の日数を過ぎたことにする（purgeTrash は 1 日以上しか受け取らない）
    await pool.query(
      `UPDATE pages
          SET created_at = created_at - make_interval(days => 32),
              updated_at = updated_at - make_interval(days => 32),
              deleted_at = deleted_at - make_interval(days => 31)
        WHERE id = $1`,
      [pageId],
    );
    const purged = await store.purgeTrash();
    assert.ok(purged.pages >= 1);
    const rows = await pool.query("SELECT count(*)::int AS count FROM ai_conversations WHERE id = $1", [added.conversation.id]);
    assert.equal(rows.rows[0]?.count, 0);
    const messages = await pool.query("SELECT count(*)::int AS count FROM ai_messages WHERE conversation_id = $1", [added.conversation.id]);
    assert.equal(messages.rows[0]?.count, 0);
  });
});
