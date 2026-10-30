#!/bin/sh
# container（Dockerfile）と同じ形で production build を動かす。PORT と HOSTNAME で待ち受けを選ぶ。
# 認証の方式の検査は scripts/server-entry.mjs が server を読み込む前に行う。
set -eu
cd "$(dirname "$0")/.."
out=.next/standalone
if [ ! -f "$out/server.js" ]; then
  echo "No production build found. Run \`npm run build\` first." >&2
  exit 1
fi
rm -rf "$out/.next/static"
cp -R .next/static "$out/.next/static"
exec node scripts/server-entry.mjs "$out/server.js"
