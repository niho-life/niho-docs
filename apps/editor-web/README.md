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
| `EDITOR_AI_MODE` | 任意。未設定・`off` は AI を使わない（提案・採用は 503 `ai_unavailable`）。`fake` は偽物のモデル（開発・CI だけ。`NODE_ENV=production` では 503） |
| `EDITOR_AI_MONTHLY_LIMIT_USD` | 任意。owner ごとの月の上限（見込みの USD）。未設定は上限なし。0 以上の数でない値は 0（AI を止める） |
| `EDITOR_STEPS_MODE` | 手順の実行の方式。`inline`（開発・CI だけ）。未設定・`off`・未知の値と、本番（`NODE_ENV=production`）の `inline` では手順の開始は 503 |

確認のコマンド: `typecheck`・`lint`・`test`（vitest）・`build`・`test:startup`（build の後。本番の起動の守り）・`test:e2e`（`DATABASE_URL` と migration が要る。`next dev` を起動して API と画面を確かめ、作った行は消す）。

## 決まっていること

- **認証（#47）**: `NODE_ENV=production` で `EDITOR_AUTH_MODE` が `niho` でなければ（未設定を含む）起動しない。本番の入口 `scripts/server-entry.mjs` が server を読み込む前（port を開く前）に `src/auth/config.ts` で検査し、`src/instrumentation.ts`（`next start` 用）と要求ごとの方式の選択でも同じ検査をする。`next build` の途中では検査しない。`niho` は `src/auth/niho.ts` の 1 ファイルに閉じ、niho-app #19459 の契約が出るまで fail-closed（いつも未認証）。stub は cookie も token も作らない。
- **ログイン（#32）**: `/auth/login`（枠の外の画面）、`/auth/login/start?next=`（GET）、`/auth/callback`（GET）、`/auth/logout`（POST。同じ origin でなければ 403）。route の応答は `Cache-Control: no-store`。未ログインで画面を開くと `/auth/login?next=…` へ移る（今の path は `src/proxy.ts` が header で渡すだけで、認証は読まない）。戻り先は `src/auth/return-to.ts` の `safeReturnTo` で editor の画面の path（`/`・`/p/new`・`/p/{uuid}`・`/destinations`・`/account`・`/settings` など）だけにし、それ以外（外の URL・`/auth/*`・`/api/*`）は `/`。stub はいつもログイン済みで、`/auth/login` は戻り先へ移る。
- **画面（#32）**: 枠は `app/(editor)/layout.tsx`（niho-docs-ui の shell）。`/` はデスクトップでは最後に開いたページ（cookie `editor_last_page` の id。無い・消えたなら `/p/new`）へ移る。`/p/new` は題名か本文を入力した時点で POST して作り、`history.replaceState` で `/p/{id}` に替える（エディタは作り直さない）。`/p/new?from=recording` は開始の画面だけ。`/destinations`・`/account`・`/settings` は題名だけ。900px 以下（shell.css と同じ）では `/` が一覧の画面で、ページと設定は全画面、ヘッダーの左のボタンで一覧を出す。
- **一覧（#32）**: 更新順（同じ時刻は id の降順）で 100 件ずつ。layout が最初の 100 件を描き、末尾が近づいたら `GET /api/pages?limit=&cursor=` で続きを読む。cursor は `<updated_at（UTC・マイクロ秒まで）>_<id>`。読み込んだ親の下に子ページを作った順で並べる。検索はサイドバーの検索入力から（下の「検索（#35）」）。
- **CSP と HSTS（#44）**: ページの CSP は `src/proxy.ts` が要求ごとに作る nonce で付ける（`src/security/csp.ts`）。script は nonce ＋ `strict-dynamic` で、インラインの script・`unsafe-eval`・外部 origin を許さない。style だけ `'self' 'unsafe-inline'`（TipTap が実行時に nonce なしの `<style>` を注入し、共有の docs-ui が SSR で `style=""` を出すため。絞るには docs-ui 側の変更が要る）。nonce は静的な HTML に入れられないので、root layout で `connection()` を呼び全 route を要求のときに描く。`/api` は何も読み込まない固定の CSP（`default-src 'none'`）。`Strict-Transport-Security` は全応答。画像・音声を GCS の署名付き URL から読む段階（#33・#36）で、その origin だけを `img-src` / `media-src` に足す。開発（`next dev`）だけ `unsafe-eval` と HMR の WebSocket を許す。
- **PWA（#49）**: `src/app/manifest.ts`（`/manifest.webmanifest`。`display: standalone`、`start_url: /`）、アイコンは `public/icons`（NIHO docs の `icon.svg` から `node scripts/build-icons.mjs` で作る。any 192/512、maskable 512、apple-touch 180。再生成は Chrome が要る）。`public/sw.js` は**殻だけ**: `/_next/static/` と offline 画面だけを手元に置き、圏外でページを開くと `/offline.html`（「つながっていません」）を出す。ページの HTML・`/api`・認証の絡む応答はキャッシュしない。オフライン編集は含まない（#50）。登録は本番だけ（`RegisterServiceWorker`）。インストール後も全ページ noindex。standalone の出力には `public/` が入らないので、`postbuild`（`scripts/copy-standalone-assets.mjs`）と Dockerfile で置く。
- **API**: `GET/POST /api/pages`、`GET/PATCH /api/pages/{id}`。`GET /api/pages` は `{ pages, next }`（next が null なら終わり。ゴミ箱のページは出さない）。未認証 401、別の人・存在しない・UUID として不正な id は同じ 404、本文は 1 MiB まで（超えたら 413）、JSON でない・形が違う・読めない limit や cursor は 400、更新系は同じ origin でなければ 403。エラーの本文は短い code だけ。
- **保存の競合**: `PATCH /api/pages/{id}` は `baseRevision`（読んだときの revision。必須）を付ける。今の revision と違えば何も書かずに 409 と今のページ（`{ error: "conflict", page }`）。自分のページでなければ revision によらず 404。「この内容で上書き」は 409 の revision を付け直し、`overwrite: true` で再送する（上書き前の本文は版に残る）。`/p/new` で作ったページは、POST の応答の revision（1）から `baseRevision` を始める。
- **保存の状態と端末の下書き（#33）**: 自動保存は入力の 1 秒後（⌘S・Ctrl+S は今すぐ）。送れない間（オフライン・サーバーの失敗・ログイン切れ）も本文は端末の IndexedDB（`niho-editor` / `page-drafts`、key はページの id）に残し、サーバーに届いたら消す。開いたときに下書きがあれば、同じ revision なら載せて送り直し、サーバーが先へ進んでいれば競合の帯を出す（`src/lib/drafts.ts`）。`/p/new` の作る前の本文は key `new` の 1 つの枠に残し、次に `/p/new` を開いたときに載せてそのままページを作る。作ったら以後の下書きはそのページの id に書き、枠の下書きは消す。
- **版**: `GET /api/pages/{id}/versions`（新しい順・最大 100）、`GET …/versions/{n}`、`POST …/versions/{n}/restore`（`baseRevision` 付き。戻す直前の本文は版に残る。今の形で保存できない古い版は 422）。自動保存は本文が変わるとき、最新の版から 10 分以上空いていれば、保存の前の本文を版にする。1 ページ 200 版を超えたら古い自動保存の版から捨てる。
- **ゴミ箱**: `DELETE /api/pages/{id}`（子孫も一緒。公開中は 409 `published`）、`GET /api/trash`、`POST /api/trash/{id}/restore`。30 日を過ぎたものは `npm -C packages/editor-store run purge-trash` が完全に削除する（定期実行の配線はクラウド側で別途）。
- **AI の提案（#38 段 1。サーバー側だけ）**: `POST /api/pages/{id}/ai/proposals`（`baseRevision`・`intent`（`{ preset }` か `{ text }`）・任意の `scope`（最上位のブロックの位置の範囲。`toIndex` を含む））は提案を返すだけで、ページには何も書かない。`POST /api/pages/{id}/ai/adoptions` は採用したものだけを、今の本文を版（`ai`）に残してから `baseRevision` 付きで保存する（履歴から戻せる）。`GET /api/ai/usage` は今月（Asia/Tokyo）の使用量。実装は `src/ai/`（提案エンジン・語単位の差分・候補・偽物のモデル・プロンプト）と `src/server/ai-api.ts`。モデルと鍵はサーバー側で、この段は偽物だけ（本物のプロバイダは後段）。
  - 編集の対象は最上位の段落と見出しだけ（箇条書き・引用・囲み・画像などは文脈として送るだけ）。段落はブロックの位置で指す。**変更した段落の太字・斜体・リンクは外れてプレーンテキストになる**（v1 の制限）。変更しない段落には触れない。
  - 足すだけの候補（要約・見出しをつける・Add headings・記事にできそうな部分・Check facts to confirm）は、モデルが既存の文の変更を返しても捨てる。長いページは段落の切れ目で約 12,000 文字ずつに分けて頼み、20 万文字を超える範囲は 413 `too_large`。
  - 使用量は表 `ai_usage`（migration 0005。owner × 月）に原子的に足す。金額は docs-core の単価表の見込み（偽物・単価不明は 0）。上限以上はモデルを呼ぶ前に 429 `quota_exceeded`、上限の 80% 以上で `nearLimit`。モデルの失敗・検証に通らない出力は 502 `ai_failed`（使った分は記録する）。
- **索引に載せない**: 全ての応答に `X-Robots-Tag: noindex, nofollow`（`next.config.ts`）、全ページに `<meta name="robots" content="noindex, nofollow">`。`robots.txt` は Disallow を付けない（クロールを止めると noindex が読まれない）。
- **本文**: niho-docs-ui の `BlockEditor`（TipTap）を使い、`blocks` は TipTap の doc の `content`（ブロックの配列）をそのまま保存する。サーバーが見るのは「`type` を持つ object の配列で、大きさと深さが上限の内側」だけ。**限定 AST としての厳密な検証（許すブロックの種類・HTML の正規化）は #33。**
- **React を 1 本にする**: `.npmrc` の `install-links=true` で packages/* を node_modules に複製して入れる。docs-ui の側の node_modules（React 18）を拾わず、react・TipTap はこの app の 1 本に解決する（`src/components/PageEditor.test.tsx` が確かめる）。packages を書き換えたら `npm install` し直し、`apps/editor-web/.next` も消す（packages の version が同じだと webpack の cache が古い版を使い続け、`next build` は警告だけで通って実行時に 500 になる。CI は毎回新しい checkout なので影響しない）。
- **bundler は webpack**（`--webpack`）: docs-core は `./types.js` で `./types.ts` を指す書き方で、Turbopack は node_modules の中のこれを解決しないため。`experimental.extensionAlias` で `.js` を `.ts` にも当てる。
- **packages/editor-store**: migration（`migrations/NNNN_*.sql`、BEGIN/COMMIT で包み辞書順）と `EditorStore`。全てのクエリが `owner` と `deleted_at IS NULL` で絞る。`page_versions` には保存・上書き・戻す直前の本文を書く。`assets`・`publications` は表だけで、書くコードはまだ無い。

## 検索（#35）

- **API**: `GET /api/search?q=&limit=`。題名と本文を、空白で区切った語の AND・大文字小文字を区別しない部分一致で探す（`%` `_` `\` は文字どおり）。自分の・ゴミ箱でないページだけ、更新順、既定 30 件・最大 100 件。結果は `{ id, kind, title, snippet, updatedAt }` だけ（snippet は当たった所の前後 約 80 字）。未認証 401、DB が無い 503、`q` が無い・空は空の結果、`q` が 100 文字を超える・`limit` が不正は 400。
- **索引**: migration `0003_search_text.sql` が `pages.search_text`（題名 + 本文の text ノードの文字だけ。generated column なので保存のコードは触らない）と pg_trgm の GIN（`deleted_at IS NULL`）を足す。pg_trgm は PostgreSQL の contrib（Cloud SQL・postgres:16-alpine・homebrew の postgresql@16 に入っている）。検索のコードは `packages/editor-store/src/search.ts`。
- **フック**: `usePageSearch(query)`（150ms 止まってから 1 回だけ問い合わせ、古い要求は中止。`idle | loading | ready | error`）と `useSearchShortcut(onOpen)`（Mac は ⌘K、それ以外は Ctrl+K。入力欄の中でも効き、IME の変換中は無視）。
- **画面（`EditorFrame`）**: サイドバーの検索入力に打つと、サーバーで題名と本文を探し、結果を更新順に出す（2 行目に当たった所の一文）。検索中は続きの読み込みを止め、一覧の下に状況（「N 件」「探しています…」「見つかりませんでした」と失敗）を `role="status"` で出す。検索語が空に戻ればふつうの一覧。⌘K（Mac 以外は Ctrl+K）で、畳まれた一覧を出し（狭い画面ではページから一覧へ）、検索入力を開いてフォーカスする。すでに開いていれば入力へフォーカスを戻す。専用のパレットは作っていない（モック v6 にもサイドバー内の検索しかない）。
- **まだ**: 絞り込み（公開中・録音・日記。`/api/search` に引数が無く、公開中は `publications` の join が要る＝公開の配線の後）。

## リンクで共有・複製・書き出し（#34）

- **API**（全て本人の・ゴミ箱でないページだけ。未認証 401、DB が無い 503、別の人・存在しない・不正な id・削除済みは同じ 404、更新系は同じ origin でなければ 403）:
  `GET /api/pages/{id}/share`（状態）・`PUT …/share`（共有を始める。冪等）・`POST …/share/rotate`（リンクを作り直す）・`DELETE …/share`（止める。冪等）は `{"share": DocsPageShareState}`（docs-core の `page-sharing.ts`）。`POST …/duplicate` は 201 `{"page"}`、`GET …/export.md` は Markdown の attachment。
- **共有の状態**: `url` は `${origin}/s/{token}`（origin は `EDITOR_ORIGIN` か Host から。決まらなければ null）。token は `url` の中だけに出し、`publicId` には token から一方向に作った値（作り直すと変わる）を入れる。`rotate` は `expectedPublicId` を見ない（今は常に作り直す）。
- **`/s/{token}`**（`src/app/s/[token]/page.tsx`。`app/(editor)` の外なので、枠・一覧を出さず、未ログインでもログインへ移さない。CSP の nonce は他の画面と同じく `src/proxy.ts` が付ける）: 認証を使わず、題名と本文（最新の保存版）だけを `src/share/render-blocks.tsx` で React の要素にする（HTML を注入しない。リンクは https・http・mailto だけ、`rel="noopener noreferrer nofollow ugc"`）。形の違う・未共有・止めた・作り直す前の token とゴミ箱のページは同じ 404、DB を使えないときは汎用の 500。header は `next.config.ts` の `/s/:token*` の規則で `Cache-Control: private, no-store`・`Referrer-Policy: no-referrer`（全体の規則の後に置き、値は 1 つ）。`next dev` はページの Cache-Control を開発用の値に置き換えるので、本番の値は `test:startup` で確かめる。
- **表**: migration `0004_page_shares.sql`（共有中のページに 1 行。止める＝行を消す。token は 256 bit の乱数の base64url を平文で持つ）。コードは `packages/editor-store/src/shares.ts`・`duplicate.ts`。
- **書き出し**（`src/export/markdown.ts`）: niho-experience の Markdown サブセット（`apps/web/src/lib/guide-markdown.ts`）として読める形だけを出す。見出しは `##`/`###`、リストは 1 行 1 項目に平坦化、引用・囲みは `:::note`、リンクは https だけ、画像・区切り線は出さない。本文の記号は `\` で逃がす（日本語は変えない）。parser の受理規則を写した oracle が `src/export/markdown.test.ts` にある。
- **画面から呼ぶ関数**: `src/lib/page-actions-client.ts`（`getPageShare`・`startPageShare`・`rotatePageShare`・`stopPageShare`・`duplicatePageRequest`（新しい id・題名・種類を返す）・`pageExportUrl`・`deletePageRequest`・`listPageVersions`・`restorePageVersion`（`baseRevision` 付き。30 秒で打ち切る））。
- **ヘッダーの状態と「…」（#34 第 1 段・第 2 段）**:
  - **状態の丸**（docs-ui の `StatusDot`）: いつも「自分だけ」＋保存の状態（「自分だけ · 保存済み」「· 保存中」「· オフライン・この端末に保持」など。言葉は `src/lib/save-status.ts`）。公開の状態（公開中・更新あり・限定公開・公開をやめた）と公開ボタンは、公開の配線（#39〜#41）ができるまで出さない。ページの外（`/`・設定・録音から）では出さない。
  - **読み上げ**: 保存の状態を読み上げるのはヘッダーの丸（`aria-live="polite"`）だけ。本文の上の「保存済み」などの表示は見える文字として残し、live region にしない（二重に読み上げない）。
  - **「…」**: リンクで共有・書き出し（.md）・履歴・複製・削除（docs-ui の `shellMoreItems` の順）。Google ドキュメントへの書き出しは NIHO の API 待ち。まだ作っていないページ（`/p/new`）と、端末の下書きを読み終える前は出さない。開閉と項目の移動は `ShellMenu`（↑↓・Home・End・Esc）で、選んだらフォーカスは「…」へ戻る。リンクで共有の補足「共有中」は、共有していると分かっているときだけ出す（`/p/{id}` の RSC が開くときに真偽だけを読んで渡し、共有のシートで読んだ・変えた値で更新する。読めなければ出さない。リンクそのものは RSC の payload に入れない）。
  - **どの操作も先に保存する**: まだ届いていない変更を今送り、全て届くまで待つ（`Autosave.settle`）。届かなければ（オフライン・ログイン切れ・サーバーの失敗・競合で止めている）操作を止め、シートも開かずに「〜の前に変更を保存できませんでした」（履歴は「履歴を開く前に…」）と出す（編集は捨てない）。同じページの操作は 1 つずつ。
  - **複製**: `POST …/duplicate` → 一覧の上に足し、`/p/{新しい id}` へ。失敗は「…」の左に短く（`role="alert"`。「複製できませんでした」）。
  - **書き出し**: 同じ origin の `<a href="/api/pages/{id}/export.md" download>` を押す（本文は fetch で読まない。ファイル名はサーバーの Content-Disposition）。
  - **削除**: 確認のダイアログ（docs-ui の `ShellSheet` を `EditorShell` の overlay に。外は inert、Esc・「やめる」で閉じ、フォーカスは「…」へ戻る）→ `DELETE /api/pages/{id}`（204）→ 一覧からそのページと子孫（読み込み済みの分。サーバーは子孫ごとゴミ箱へ入れる）を外し、`/` へ（`editor_last_page` が消したページを指していても、`/` はサーバーで確かめて新しいページへ移す）。409 `published` は「公開中のページは、先に公開をやめてください」、他の失敗は「削除できませんでした」をダイアログの中に出し、閉じない（一覧もページもそのまま）。送っている間は 2 回目を送らず、閉じない（応答は 30 秒で打ち切る）。
  - **リンクで共有**（`src/lib/use-page-share.ts`・`src/components/ShareSheet.tsx`。ShellSheet）: 開くたびに `GET …/share` を読む（その間「読み込み中」を `role="status"`）。共有していなければ「リンクを作る」（`PUT`）、共有中ならリンク（読み取り専用の入力）・「コピー」・「作り直す」・「共有を止める」（`DELETE`）。「作り直す」はその場で「作り直すと、古いリンクは読めなくなります。」と確かめてから `POST …/share/rotate`（やめる・Esc は確かめるのをやめるだけ）。コピーは `navigator.clipboard.writeText`、使えなければ入力を選んで「⌘C でコピー」（Mac 以外は Ctrl+C）。作った・作り直した・止めた・コピーしたは同じ `role="status"` で短く知らせ、失敗はシートの中に短く（閉じない）。操作は同じページで 1 つずつで、送っている間もシートは閉じられる（開き直すと、その結果を待つ。2 つ目は送らない）。リンクは共有中のこのシートにだけ出し、例外・ログには入れない。
  - **履歴**（`src/lib/use-page-history.ts`・`src/components/HistorySheet.tsx`。ShellSheet）: 開くたびに `GET …/versions`（新しい順）を読み、各行に いつ（一覧と同じ `formatWhen`）・理由（自動保存／AI の提案の前／公開／上書きの前／戻す前）・ブロック数・「この版に戻す」。0 件は「まだ履歴がありません」。「この版に戻す」は同じシートで確かめる（「本文がこの版になります（題名はそのまま）。いまの本文は、戻したあとも履歴から戻せます。」。サーバーは戻す前の本文を版 `restore` に残してから戻し、題名は変えない）。「戻す」でもう一度保存を確かめ、今の revision を `baseRevision` に `POST …/versions/{n}/restore`。409 は「別の画面で保存されました。開き直してからもう一度」、422 は「この版には戻せません」（どちらもシートの中。閉じない）。戻している間は閉じず、2 回目を送らない。戻せたらシートを閉じ、エディタを応答のページ（題名・本文・revision）で開き直し（`PageEditor` が key を替えて作り直す。保存・下書き・Undo の部品も新しく、次の保存はその revision の上に送るので競合にしない。端末の下書きは開いたときと同じく比べ直す）、ヘッダーの `role="status"` で「この版の本文に戻しました」と知らせ、一覧の上へ動かす。下書きを読み直す間に「…」が消えてフォーカスが外れたら、出し直したときに「…」へ戻す。
  - **枠とページの橋渡し**: ヘッダーは枠（`EditorFrame`）、保存の状態とエディタはページの中（`PageEditor`）にあるので、`PageEditor` が `useEditorFrame().attachPage({ id, status, flush, revision, reopen, shared, setShared })`（`src/lib/attached-page.ts`）で自分を登録し（保存の状態が変わるたびに登録し直す）、画面を離れたら外す。操作は「…」を開いたページの id に対して行い、終わったときに別のページへ移っていたら（id と flush で見分ける。版に戻して開き直した画面も別の画面）、その画面には何も出さず移動も開き直しもしない（複製・削除が済んだことは一覧には反映する）。一覧からは `pageRemoved(id)` で外す。
  - **まだ**: 版の中身を見る（`GET …/versions/{n}` は使っていない。一覧から戻すだけ）、情報パネル、写真の zip と Google ドキュメントへの書き出し。競合の帯が出ている（自動保存を止めている）間は、共有・履歴も開かない（先に帯で決める）。検索の結果からは、この画面で削除したページと一覧に読み込んであった子孫だけを外す（読み込んでいない子孫は、次に探すまで結果に残る）。

## 手順（#37）

録音ページから手順（記事制作 `tpl-1`・議事録 `tpl-2`・インサイト整理 `tpl-3`。docs-core のテンプレートの写し）を実行し、各段階の結果をサブページ（`kind=step`）に書く。方式は [editor-steps-execution.md](../../docs/architecture/editor-steps-execution.md) の B。**今は実行の骨格だけで、実行器は偽物（`[fake]` の印を付けた決定的な結果。AI は呼ばない）。**

- **API**: `POST /api/pages/{id}/steps/runs`（`{ recipe, fromStep? }`、任意の `Idempotency-Key`。202。進行中は 409 `run_in_progress`、上流が済んでいない `fromStep` は 400 `invalid_from_step`、方式が無いと 503 `steps_unavailable`）、`GET /api/pages/{id}/steps`（最新の run。返す前に前提変更を再計算）、`POST /api/pages/{id}/steps/runs/{runId}/cancel`（冪等）。作法は `/api/pages` と同じ（401・403・404 は同一・413・noindex）。
- **状態の正**は `packages/editor-store/src/step-runs.ts`（表は migration `0006_step_runs.sql`）。遷移はすべて世代と状態を条件にした UPDATE で、claim のたびに世代が進み、確定・失敗・生存確認は世代が一致するときだけ通る（取消・lease 切れの後に遅れて返った結果で上書きしない）。確定（サブページの本文と状態・次の段階）は 1 transaction。
- **サブページの id** は親・recipe・段階から決定的に作る（作り直しても同じページ）。`fromStep` から作り直すと、前の段階の済んだサブページを再利用する。
- **失敗**: 一時的な失敗は 3 回まで（間隔を空けて積み直す）、超えるか入力の誤りなら失敗。後続は取り消し、上流は残す。lease が切れた段階は `sweepExpiredLeases` が積み直す（定期の呼び出しは後段）。
- **前提変更**: 前の段階（段階 0 は録音ページ）の本文と指示文の基準が、実行したときの基準と違えば、その段階から後を `stale` にし、戻れば `done` に戻す。
- **実行**（`src/steps/`）: `runAttempt` が claim → 入力を読む → 生存確認（lease の 1/3 おき）→ 実行器 → 確定 → 次を積む。`inline` は同じプロセスで最後まで進める（要求は待たない）。**Cloud Tasks・内向きの worker の route と OIDC・本物の AI・画面は後段**。

## 録音と文字起こし（#36 段 1）

- **API**（全て本人の・ゴミ箱でないページだけ。未認証 401、DB が無い 503、更新系は同じ origin でなければ 403）:
  `POST /api/recordings/import-vtt`（本文 `{ name, vtt, lang? }`。録音ページ（`kind=rec`・本文は空）と文字起こしを 1 つの transaction で作り、201 `{ page, recording, speakers }`）・
  `GET /api/pages/{id}/recording`（200 `{ recording, speakers }`）・`PATCH /api/pages/{id}/recording`（`baseRevision` と、`edits`・`renameSpeaker`・`mergeSpeakers` のちょうど 1 つ）。
  別の人・存在しない・不正な id・削除済み・録音の無いページは同じ 404。400 の本文は `{"error":"bad_request","reason":…}`（`body`・`name`・`lang`・`vtt_empty`・`vtt_too_large`・`vtt_invalid`・`index`・`text`・`speaker`・`merge`）。
- **競合**: 書き込みは `baseRevision` が今の `revision` と同じときだけ（行を `FOR UPDATE` で押さえて比べる）。違えば書かずに 409 `{"error":"conflict","recording","speakers"}` で最新を返す（画面は自分の文章を残したまま、最新に当て直せる）。成功すると `revision` が 1 進む。
- **形**: `segments` は docs-core の `SpeechResultV1` と同じ `{ start, end, text, speaker }`（時刻は秒、話者は 1 始まりの番号か null）。名前は `speakerNames`（番号 → 名前）の表に 1 つだけ持ち、表示は番号から引く（名前を変えると全段落に反映される）。話者名の規則は docs-core の `resolveTranscriptSpeakerName`（60 文字・改行とコロンなし・「話者N」の形は不可・NFKC で同じに見える名前は不可）と、制御文字なし。
- **VTT**（`src/recording/vtt-import.ts`）: docs-core の `parseVtt` で検査し、cue を段落にする。`<v 話者>` は最初に出た順に 1 から番号を付け、規則に合わない名前は番号だけ。1 つの cue に別々の話者がいれば話者ごとに分ける。タグは外し、文字参照は文字に戻す。題名はファイル名（パスと拡張子を除く）、原本は SHA-256 と名前だけを持つ。
- **上限**: VTT は UTF-8 で 4 MiB（取り込みの要求の本文は 5 MiB まで。超えたら 413）、段落は 20,000 個・1 段落 5,000 文字・本文の合計 8 MiB（docs-core の文字起こしの同期上限と同じ）、1 回の `edits` は 200 件（`PATCH` の本文は 4 MiB まで）。
- **表**: migration `0007_page_recordings.sql`（録音ページに 1 行。ページを消す（hard delete）と消える。ゴミ箱の間は残る）。コードは `packages/editor-store/src/recordings.ts`、段落と話者の操作（純粋な関数）は `src/recording/`。
- **まだ**: 音声の取り込み・エンジン（段 2）、マイク録音・再生・タイムスタンプの画面（段 3）。

## まだやらないこと

見た目（#48）、版・履歴・オフライン・画像・ブロックと「/」メニューの仕上げ・IME の扱い（#33）、一覧の 2 行目の公開先（#39）、公開と公開 API（#39〜#41）、録音の開始（#36）、検索の絞り込み（#35）、発信先・役割とつながり・設定の中身（#41・#42 とその後）、AI の画面・本物のプロバイダ・固有名詞の設定（#38 の後段）、niho モードの実装（niho-app #19459）、GCS バケット・Cloud Run・Cloud SQL の実環境と secret。
