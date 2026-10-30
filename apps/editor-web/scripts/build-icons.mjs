// PWA のアイコン（#49）を NIHO docs の icon.svg から作り直す。描画は Chrome のヘッドレス（グラデーションとドロップシャドウを正しく描ける）。
//   node scripts/build-icons.mjs            # CHROME=/path/to/chrome で実行ファイルを指定できる
// - icon-192.png / icon-512.png : 元の絵そのまま（角丸のタイル。透明な余白あり）。purpose: any
// - icon-maskable-512.png       : 透明な余白と影を除き、全面に背景を敷いてグリフを中央 80% の安全領域に収める。purpose: maskable
// - apple-touch-icon.png (180)  : iOS は透明を黒く塗るので、全面に背景を敷いた同じ絵
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(appDir, "../docs/src-tauri/icons/icon.svg");
const outDir = path.join(appDir, "public/icons");
const BACKGROUND = "#F7F5EF";
// 元の絵のグリフ（書類とペン）は translate(33 33) scale(1.9)。グリフの中心は元の座標で (50, 50)。
// 中央に置き直し、半対角が安全領域（半径 0.4）に収まる倍率にする。
const GLYPH_TRANSFORM = 'translate(33 33) scale(1.9)';
const FULL_BLEED_TRANSFORM = 'translate(128 128) scale(2) translate(-50 -50)';

const svg = readFileSync(source, "utf8");
if (!svg.includes(GLYPH_TRANSFORM)) throw new Error("icon.svg changed: the glyph transform was not found");
const fullBleed = svg
  .replace(/^\s*<rect [^>]*\/>\s*$/gm, "") // タイルの本体と縁の 2 つ
  .replace('<g transform="' + GLYPH_TRANSFORM + '">', `<rect width="256" height="256" fill="${BACKGROUND}"/>\n<g transform="${FULL_BLEED_TRANSFORM}">`);
if (fullBleed.includes("<rect x=")) throw new Error("icon.svg changed: the tile rects were not removed");

const dir = mkdtempSync(path.join(tmpdir(), "editor-icons-"));
try {
  const bleedPath = path.join(dir, "full-bleed.svg");
  writeFileSync(bleedPath, fullBleed);
  const jobs = [
    [source, "icon-192.png", 192],
    [source, "icon-512.png", 512],
    [bleedPath, "icon-maskable-512.png", 512],
    [bleedPath, "apple-touch-icon.png", 180],
  ];
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const [input, name, size] of jobs) {
    // 透明な背景のまま、指定の大きさで 1 枚だけ描く
    copyFileSync(input, path.join(dir, "art.svg"));
    const page = path.join(dir, "page.html");
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="art.svg">`);
    const out = path.join(outDir, name);
    const result = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${out}`, `file://${page}`], { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`chrome failed for ${name}`);
    process.stdout.write(`wrote public/icons/${name} (${size}x${size})\n`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
