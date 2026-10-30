import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 検証用のギャラリー（配布物に入らない）。vite は vitest の依存として docs-ui の node_modules にある。
//   cd packages/docs-ui && npx vite --config gallery/vite.config.mjs --port 5199
const here = path.dirname(fileURLToPath(import.meta.url));
const docsUi = path.resolve(here, "..");

export default defineConfig({
  root: here,
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom", "@tiptap/core", "@tiptap/pm", "@tiptap/react"] },
  server: {
    port: 5199,
    strictPort: true,
    // niho-ui は ../ui への symlink。src・tokens はその外から読むので許可する。
    fs: { allow: [docsUi, path.resolve(docsUi, "../ui")] },
  },
});
