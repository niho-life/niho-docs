import type { Metadata } from "next";
import { getEditorSettings } from "@niho/editor-store";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsView } from "@/components/SettingsView";
import { getPool } from "@/server/db";
import { requireSession } from "@/server/session";
import { settingsDto } from "@/server/settings-api";
import { settingsFacts } from "@/settings/facts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "設定" };

/**
 * 設定（#108）。AI の提案の言語・固有名詞・手順は変えられ（`PATCH /api/settings`）、
 * 文字起こしのエンジンと保存先は読むだけ（サーバーの設定と NIHO から毎回読む値。設計 §2.1）。
 * 最初の値はここで読む（画面を開いたときに空から始めない）。使用量は画面が `GET /api/ai/usage` を読む。
 */
export default async function SettingsPage() {
  const session = await requireSession("/settings");
  const pool = getPool();
  if (!pool) return <StoreUnavailable />;
  const [settings, facts] = await Promise.all([getEditorSettings(pool, session.userId), settingsFacts(session)]);
  return <SettingsView initial={settingsDto(settings)} facts={facts} />;
}
