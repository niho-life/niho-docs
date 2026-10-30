# editor-web（editor.niho.life）

NIHO editor の Web。Next 16（App Router）。今は「空のページを作る → 書く → 再読み込みで残る」までの土台（#46・#47）。
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
- **CSP と HSTS（#44）**: ページの CSP は `src/proxy.ts` が要求ごとに作る nonce で付ける（`src/security/csp.ts`）。script は nonce ＋ `strict-dynamic` で、インラインの script・`unsafe-eval`・外部 origin を許さない。style だけ `'self' 'unsafe-inline'`（TipTap が実行時に nonce なしの `<style>` を注入し、共有の docs-ui が SSR で `style=""` を出すため。絞るには docs-ui 側の変更が要る）。nonce は静的な HTML に入れられないので、root layout で `connection()` を呼び全 route を要求のときに描く。`/api` は何も読み込まない固定の CSP（`default-src 'none'`）。`Strict-Transport-Security` は全応答。画像・音声を GCS の署名付き URL から読む段階（#33・#36）で、その origin だけを `img-src` / `media-src` に足す。開発（`next dev`）だけ `unsafe-eval` と HMR の WebSocket を許す。
- **API**: `GET/POST /api/pages`、`GET/PATCH /api/pages/{id}`。未認証 401、別の人・存在しない・UUID として不正な id は同じ 404、本文は 1 MiB まで（超えたら 413）、JSON でない・形が違うと 400、更新系は同じ origin でなければ 403。エラーの本文は短い code だけ。
- **保存の競合**: `PATCH /api/pages/{id}` は `baseRevision`（読んだときの revision。必須）を付ける。今の revision と違えば何も書かずに 409 と今のページ（`{ error: "conflict", page }`）。自分のページでなければ revision によらず 404。「この内容で上書き」は 409 の revision を付け直し、`overwrite: true` で再送する（上書き前の本文は版に残る）。
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
- **フック**（画面への組み込みは #32）: `usePageSearch(query)`（150ms 止まってから 1 回だけ問い合わせ、古い要求は中止。`idle | loading | ready | error`）と `useSearchShortcut(onOpen)`（Mac は ⌘K、それ以外は Ctrl+K。入力欄の中でも効き、IME の変換中は無視）。docs-ui の `ShellSidebar` にはこう渡す:

```tsx
const [find, setFind] = useState({ open: false, value: "" }), open = () => setFind((s) => ({ ...s, open: true }));
useSearchShortcut(open);
const found = usePageSearch(find.open ? find.value : ""); // found.results を一覧に出す（loading の間は前の結果のまま）
<ShellSidebar /* … */ search={{ ...find, onOpen: open, onClose: () => setFind({ open: false, value: "" }), onChange: (value) => setFind((s) => ({ ...s, value })) }} />
```

## 手順（#37）

録音ページから手順（記事制作 `tpl-1`・議事録 `tpl-2`・インサイト整理 `tpl-3`。docs-core のテンプレートの写し）を実行し、各段階の結果をサブページ（`kind=step`）に書く。方式は [editor-steps-execution.md](../../docs/architecture/editor-steps-execution.md) の B。**今は実行の骨格だけで、実行器は偽物（`[fake]` の印を付けた決定的な結果。AI は呼ばない）。**

- **API**: `POST /api/pages/{id}/steps/runs`（`{ recipe, fromStep? }`、任意の `Idempotency-Key`。202。進行中は 409 `run_in_progress`、上流が済んでいない `fromStep` は 400 `invalid_from_step`、方式が無いと 503 `steps_unavailable`）、`GET /api/pages/{id}/steps`（最新の run。返す前に前提変更を再計算）、`POST /api/pages/{id}/steps/runs/{runId}/cancel`（冪等）。作法は `/api/pages` と同じ（401・403・404 は同一・413・noindex）。
- **状態の正**は `packages/editor-store/src/step-runs.ts`（表は migration `0006_step_runs.sql`）。遷移はすべて世代と状態を条件にした UPDATE で、claim のたびに世代が進み、確定・失敗・生存確認は世代が一致するときだけ通る（取消・lease 切れの後に遅れて返った結果で上書きしない）。確定（サブページの本文と状態・次の段階）は 1 transaction。
- **サブページの id** は親・recipe・段階から決定的に作る（作り直しても同じページ）。`fromStep` から作り直すと、前の段階の済んだサブページを再利用する。
- **失敗**: 一時的な失敗は 3 回まで（間隔を空けて積み直す）、超えるか入力の誤りなら失敗。後続は取り消し、上流は残す。lease が切れた段階は `sweepExpiredLeases` が積み直す（定期の呼び出しは後段）。
- **前提変更**: 前の段階（段階 0 は録音ページ）の本文と指示文の基準が、実行したときの基準と違えば、その段階から後を `stale` にし、戻れば `done` に戻す。
- **実行**（`src/steps/`）: `runAttempt` が claim → 入力を読む → 生存確認（lease の 1/3 おき）→ 実行器 → 確定 → 次を積む。`inline` は同じプロセスで最後まで進める（要求は待たない）。**Cloud Tasks・内向きの worker の route と OIDC・本物の AI・画面は後段**。

## まだやらないこと

見た目（#48）、NIHO ログイン・サイドバー・`/auth/*`（#32）、版・履歴・オフライン・画像・ブロックと「/」メニューの仕上げ・IME の扱い（#33。今の「/」メニューは docs-ui の BlockEditor のまま）、公開と公開 API（#39〜#41）、AI の画面・本物のプロバイダ・固有名詞の設定（#38 の後段）、niho モードの実装（niho-app #19459）、GCS バケット・Cloud Run・Cloud SQL の実環境と secret。
