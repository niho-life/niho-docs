import { mkdirSync, rmSync } from "node:fs";

import { AXE_ACTUAL_DIR } from "./paths";

/** 前回の実行結果（許容リスト更新用の作業ファイル）を消す。 */
export default function globalSetup(): void {
  rmSync(AXE_ACTUAL_DIR, { recursive: true, force: true });
  mkdirSync(AXE_ACTUAL_DIR, { recursive: true });
}
