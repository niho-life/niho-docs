import "server-only";
import { EditorStore } from "@niho/editor-store";
import { Pool } from "pg";

type PoolHolder = { pool: Pool; url: string };

// dev の再読み込みで Pool が増えないよう、process に 1 つだけ持つ
const holder = globalThis as typeof globalThis & { __nihoEditorPool?: PoolHolder };

/**
 * DATABASE_URL から Pool を遅延して作る（import 時・build 時には接続しない）。未設定なら null（呼び出し側で 503）。
 */
export function getStore(env: Readonly<Record<string, string | undefined>> = process.env): EditorStore | null {
  const url = env.DATABASE_URL;
  if (!url) return null;
  if (holder.__nihoEditorPool?.url !== url) {
    const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
    // 使っていない接続の切断で process を落とさない（値は出さない）
    pool.on("error", (error) => {
      console.error("editor-web: idle database client error", { name: error.name });
    });
    holder.__nihoEditorPool = { pool, url };
  }
  return new EditorStore(holder.__nihoEditorPool.pool);
}
