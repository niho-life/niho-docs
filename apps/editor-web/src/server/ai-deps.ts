import "server-only";
import {
  appendTurn,
  getAiUsage,
  getAiUsageBySource,
  getAssistantMessage,
  getConversation,
  getEditorSettings,
  listConversations,
  listReferencePages,
  recordAdoption,
  recordAiUsage,
} from "@niho/editor-store";
import { monthlyLimitUsd, resolveAiBackend } from "../ai/config";
import { getAuthProvider } from "../auth";
import type { AiApiDeps } from "./ai-api";
import { getPool, getStore } from "./db";

/**
 * AI の route の実行時の依存（方式・DB・モデル・上限は要求のたびに遅延して決める。Pool は getStore と共有）。
 * deps.ts と並行して触らないよう、ここに置いている。
 */
export const aiDeps: AiApiDeps = {
  auth: () => getAuthProvider(),
  store: () => getStore(),
  usage: () => {
    const pool = getPool();
    return pool
      ? {
          get: (owner, month, source) => getAiUsage(pool, owner, month, source),
          record: (owner, month, delta, source) => recordAiUsage(pool, owner, month, delta, source),
          bySource: (owner, month) => getAiUsageBySource(pool, owner, month),
        }
      : null;
  },
  references: () => {
    const pool = getPool();
    return pool ? (owner, pageId) => listReferencePages(pool, owner, pageId) : null;
  },
  conversations: () => {
    const pool = getPool();
    return pool
      ? {
          append: (owner, input) => appendTurn(pool, owner, input),
          list: (owner, pageId) => listConversations(pool, owner, pageId),
          get: (owner, pageId, conversationId) => getConversation(pool, owner, pageId, conversationId),
          message: (owner, pageId, messageId) => getAssistantMessage(pool, owner, pageId, messageId),
          adopt: (owner, input) => recordAdoption(pool, owner, input),
        }
      : null;
  },
  settings: () => {
    const pool = getPool();
    return pool ? (owner) => getEditorSettings(pool, owner) : null;
  },
  ai: () => resolveAiBackend(process.env),
  limitUsd: () => monthlyLimitUsd(process.env),
};
