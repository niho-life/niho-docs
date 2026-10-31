import "server-only";
import { getAiUsage, getEditorSettings, recordAiUsage } from "@niho/editor-store";
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
          get: (owner, month) => getAiUsage(pool, owner, month),
          record: (owner, month, delta) => recordAiUsage(pool, owner, month, delta),
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
