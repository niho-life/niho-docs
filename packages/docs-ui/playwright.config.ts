import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { CACHE_DIR } from "./e2e/support/paths";

// 実ブラウザ（chromium）で gallery を開いて検査する（Issue #43）。vitest（src の単体テスト）とは別の入口:
//   npm -C packages/docs-ui run test:browser
// gallery は配布物に入らない検証用ページ（gallery/）。vite の dev server を webServer で起動して使う。
const PORT = 5199;

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  outputDir: path.join(CACHE_DIR, "test-results"),
  globalSetup: "./e2e/support/global-setup.ts",
  globalTeardown: "./e2e/support/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  // 1 つの検査（#_check の全画面走査）が長いので、既定の 30 秒より余裕を持たせる
  timeout: 60_000,
  reporter: isCI
    ? [["list"], ["html", { outputFolder: path.join(CACHE_DIR, "playwright-report"), open: "never" }]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // 色・文字・動きを環境で揺らさない（axe の color-contrast と、はみ出しの測定が、同じ前提で走る）
    colorScheme: "light",
    locale: "ja-JP",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --config gallery/vite.config.mjs --port ${PORT}`,
    url: `http://localhost:${PORT}/`,
    // 手元では起動済みの gallery を使い回す。CI は毎回新しく起動する
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
