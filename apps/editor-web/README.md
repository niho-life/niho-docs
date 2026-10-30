# editor-web（editor.niho.life）

NIHO editor の Web。Next 16（App Router）。今は枠（NIHO ログインの入口・サイドバー・ページの一覧・新しいページ）と、ページを書いて残すところまで（#46・#47・#32）。
設計は [docs/architecture/editor-niho-life-design.md](../../docs/architecture/editor-niho-life-design.md)。

## ローカルで動かす

前提: Node 24、PostgreSQL 16（空の DB を 1 つ）。

```sh
# 1. 依存（packages/* は install-links で複製して入る。packages を変えたら入れ直す）
npm -C apps/editor-web ci
npm -C packages/editor-store ci

# 2. 空の DB に migration を適用（未適用のものだけ。適用済みは editor_store_migrations に記録）
export DATABASE_URL=postgres://<user>@127.0.0.1:5432/<db>
npm -C packages/editor-store run migrate

# 3. stub で起動（開発用の固定ユーザー。画面の右下に「stub」と出る）
EDITOR_AUTH_MODE=stub npm -C apps/editor-web run dev
```

| 環境変数 | 意味 |
| --- | --- |
| `DATABASE_URL` | ページの正本の PostgreSQL。未設定なら API は 503、画面は「保存先を使えません」 |
| `EDITOR_AUTH_MODE` | `stub`（開発・CI だけ）か `niho`。開発では未設定で `stub` |
| `EDITOR_ORIGIN` | 任意。更新系の要求の Origin 検査に使う origin（未設定なら Host と転送の header から） |

確認のコマンド: `typecheck`・`lint`・`test`（vitest）・`build`・`test:startup`（build の後。本番の起動の守り）・`test:e2e`（`DATABASE_URL` と migration が要る。`next dev` を起動して API と画面を確かめ、作った行は消す）。

## 決まっていること

- **認証（#47）**: `NODE_ENV=production` で `EDITOR_AUTH_MODE` が `niho` でなければ（未設定を含む）起動しない。本番の入口 `scripts/server-entry.mjs` が server を読み込む前（port を開く前）に `src/auth/config.ts` で検査し、`src/instrumentation.ts`（`next start` 用）と要求ごとの方式の選択でも同じ検査をする。`next build` の途中では検査しない。`niho` は `src/auth/niho.ts` の 1 ファイルに閉じ、niho-app #19459 の契約が出るまで fail-closed（いつも未認証）。stub は cookie も token も作らない。
- **ログイン（#32）**: `/auth/login`（枠の外の画面）、`/auth/login/start?next=`（GET）、`/auth/callback`（GET）、`/auth/logout`（POST。同じ origin でなければ 403）。route の応答は `Cache-Control: no-store`。未ログインで画面を開くと `/auth/login?next=…` へ移る（今の path は `src/proxy.ts` が header で渡すだけで、認証は読まない）。戻り先は `src/auth/return-to.ts` の `safeReturnTo` で editor の画面の path（`/`・`/p/new`・`/p/{uuid}`・`/destinations`・`/account`・`/settings` など）だけにし、それ以外（外の URL・`/auth/*`・`/api/*`）は `/`。stub はいつもログイン済みで、`/auth/login` は戻り先へ移る。
- **画面（#32）**: 枠は `app/(editor)/layout.tsx`（niho-docs-ui の shell）。`/` はデスクトップでは最後に開いたページ（cookie `editor_last_page` の id。無い・消えたなら `/p/new`）へ移る。`/p/new` は題名か本文を入力した時点で POST して作り、`history.replaceState` で `/p/{id}` に替える（エディタは作り直さない）。`/p/new?from=recording` は開始の画面だけ。`/destinations`・`/account`・`/settings` は題名だけ。900px 以下（shell.css と同じ）では `/` が一覧の画面で、ページと設定は全画面、ヘッダーの左のボタンで一覧を出す。
- **一覧（#32）**: 更新順（同じ時刻は id の降順）で 100 件ずつ。layout が最初の 100 件を描き、末尾が近づいたら `GET /api/pages?limit=&cursor=` で続きを読む。cursor は `<updated_at（UTC・マイクロ秒まで）>_<id>`。読み込んだ親の下に子ページを作った順で並べる。検索は今は読み込んだ行の題名だけ。
- **CSP と HSTS（#44）**: ページの CSP は `src/proxy.ts` が要求ごとに作る nonce で付ける（`src/security/csp.ts`）。script は nonce ＋ `strict-dynamic` で、インラインの script・`unsafe-eval`・外部 origin を許さない。style だけ `'self' 'unsafe-inline'`（TipTap が実行時に nonce なしの `<style>` を注入し、共有の docs-ui が SSR で `style=""` を出すため。絞るには docs-ui 側の変更が要る）。nonce は静的な HTML に入れられないので、root layout で `connection()` を呼び全 route を要求のときに描く。`/api` は何も読み込まない固定の CSP（`default-src 'none'`）。`Strict-Transport-Security` は全応答。画像・音声を GCS の署名付き URL から読む段階（#33・#36）で、その origin だけを `img-src` / `media-src` に足す。開発（`next dev`）だけ `unsafe-eval` と HMR の WebSocket を許す。
- **PWA（#49）**: `src/app/manifest.ts`（`/manifest.webmanifest`。`display: standalone`、`start_url: /`）、アイコンは `public/icons`（NIHO docs の `icon.svg` から `node scripts/build-icons.mjs` で作る。any 192/512、maskable 512、apple-touch 180。再生成は Chrome が要る）。`public/sw.js` は**殻だけ**: `/_next/static/` と offline 画面だけを手元に置き、圏外でページを開くと `/offline.html`（「つながっていません」）を出す。ページの HTML・`/api`・認証の絡む応答はキャッシュしない。オフライン編集は含まない（#50）。登録は本番だけ（`RegisterServiceWorker`）。インストール後も全ページ noindex。standalone の出力には `public/` が入らないので、`postbuild`（`scripts/copy-standalone-assets.mjs`）と Dockerfile で置く。
- **API**: `GET/POST /api/pages`、`GET/PATCH /api/pages/{id}`。`GET /api/pages` は `{ pages, next }`（next が null なら終わり。ゴミ箱のページは出さない）。未認証 401、別の人・存在しない・UUID として不正な id は同じ 404、本文は 1 MiB まで（超えたら 413）、JSON でない・形が違う・読めない limit や cursor は 400、更新系は同じ origin でなければ 403。エラーの本文は短い code だけ。
- **保存の競合**: `PATCH /api/pages/{id}` は `baseRevision`（読んだときの revision。必須）を付ける。今の revision と違えば何も書かずに 409 と今のページ（`{ error: "conflict", page }`）。自分のページでなければ revision によらず 404。「この内容で上書き」は 409 の revision を付け直し、`overwrite: true` で再送する（上書き前の本文は版に残る）。`/p/new` で作ったページは、POST の応答の revision（1）から `baseRevision` を始める。
- **保存の状態と端末の下書き（#33）**: 自動保存は入力の 1 秒後（⌘S・Ctrl+S は今すぐ）。送れない間（オフライン・サーバーの失敗・ログイン切れ）も本文は端末の IndexedDB（`niho-editor` / `page-drafts`、key はページの id）に残し、サーバーに届いたら消す。開いたときに下書きがあれば、同じ revision なら載せて送り直し、サーバーが先へ進んでいれば競合の帯を出す（`src/lib/drafts.ts`）。`/p/new` の作る前の本文は key `new` の 1 つの枠に残し、次に `/p/new` を開いたときに載せてそのままページを作る。作ったら以後の下書きはそのページの id に書き、枠の下書きは消す。
- **版**: `GET /api/pages/{id}/versions`（新しい順・最大 100）、`GET …/versions/{n}`、`POST …/versions/{n}/restore`（`baseRevision` 付き。戻す直前の本文は版に残る。今の形で保存できない古い版は 422）。自動保存は本文が変わるとき、最新の版から 10 分以上空いていれば、保存の前の本文を版にする。1 ページ 200 版を超えたら古い自動保存の版から捨てる。
- **ゴミ箱**: `DELETE /api/pages/{id}`（子孫も一緒。公開中は 409 `published`）、`GET /api/trash`、`POST /api/trash/{id}/restore`。30 日を過ぎたものは `npm -C packages/editor-store run purge-trash` が完全に削除する（定期実行の配線はクラウド側で別途）。
- **索引に載せない**: 全ての応答に `X-Robots-Tag: noindex, nofollow`（`next.config.ts`）、全ページに `<meta name="robots" content="noindex, nofollow">`。`robots.txt` は Disallow を付けない（クロールを止めると noindex が読まれない）。
- **本文**: niho-docs-ui の `BlockEditor`（TipTap）を使い、`blocks` は TipTap の doc の `content`（ブロックの配列）をそのまま保存する。サーバーが見るのは「`type` を持つ object の配列で、大きさと深さが上限の内側」だけ。**限定 AST としての厳密な検証（許すブロックの種類・HTML の正規化）は #33。**
- **React を 1 本にする**: `.npmrc` の `install-links=true` で packages/* を node_modules に複製して入れる。docs-ui の側の node_modules（React 18）を拾わず、react・TipTap はこの app の 1 本に解決する（`src/components/PageEditor.test.tsx` が確かめる）。packages を書き換えたら `npm install` し直し、`apps/editor-web/.next` も消す（packages の version が同じだと webpack の cache が古い版を使い続け、`next build` は警告だけで通って実行時に 500 になる。CI は毎回新しい checkout なので影響しない）。
- **bundler は webpack**（`--webpack`）: docs-core は `./types.js` で `./types.ts` を指す書き方で、Turbopack は node_modules の中のこれを解決しないため。`experimental.extensionAlias` で `.js` を `.ts` にも当てる。
- **packages/editor-store**: migration（`migrations/NNNN_*.sql`、BEGIN/COMMIT で包み辞書順）と `EditorStore`。全てのクエリが `owner` と `deleted_at IS NULL` で絞る。`page_versions` には保存・上書き・戻す直前の本文を書く。`assets`・`publications` は表だけで、書くコードはまだ無い。

## 検索（#35）

- **API**: `GET /api/search?q=&limit=`。題名と本文を、空白で区切った語の AND・大文字小文字を区別しない部分一致で探す（`%` `_` `\` は文字どおり）。自分の・ゴミ箱でないページだけ、更新順、既定 30 件・最大 100 件。結果は `{ id, kind, title, snippet, updatedAt }` だけ（snippet は当たった所の前後 約 80 字）。未認証 401、DB が無い 503、`q` が無い・空は空の結果、`q` が 100 文字を超える・`limit` が不正は 400。
- **索引**: migration `0003_search_text.sql` が `pages.search_text`（題名 + 本文の text ノードの文字だけ。generated column なので保存のコードは触らない）と pg_trgm の GIN（`deleted_at IS NULL`）を足す。pg_trgm は PostgreSQL の contrib（Cloud SQL・postgres:16-alpine・homebrew の postgresql@16 に入っている）。検索のコードは `packages/editor-store/src/search.ts`。
- **フック**（画面への組み込みは #32）: `usePageSearch(query)`（150ms 止まってから 1 回だけ問い合わせ、古い要求は中止。`idle | loading | ready | error`）と `useSearchShortcut(onOpen)`（Mac は ⌘K、それ以外は Ctrl+K。入力欄の中でも効き、IME の変換中は無視）。docs-ui の `ShellSidebar` にはこう渡す:

```tsx
const [find, setFind] = useState({ open: false, value: "" }), open = () => setFind((s) => ({ ...s, open: true }));
useSearchShortcut(open);
const found = usePageSearch(find.open ? find.value : ""); // found.results を一覧に出す（loading の間は前の結果のまま）
<ShellSidebar /* … */ search={{ ...find, onOpen: open, onClose: () => setFind({ open: false, value: "" }), onChange: (value) => setFind((s) => ({ ...s, value })) }} />
```

## まだやらないこと

見た目（#48）、版・履歴・オフライン・画像・ブロックと「/」メニューの仕上げ・IME の扱い（#33）、一覧の 2 行目の公開先（#39）、公開と公開 API（#39〜#41）、録音の開始（#36）、題名と本文の検索（#35）、発信先・役割とつながり・設定の中身（#41・#42 とその後）、niho モードの実装（niho-app #19459）、GCS バケット・Cloud Run・Cloud SQL の実環境と secret。
