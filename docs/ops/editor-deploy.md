# editor.niho.life の配備

`apps/editor-web` を GCP（Cloud Run・Cloud SQL・GCS）に配備する手順。設計は [editor-niho-life-design.md](../architecture/editor-niho-life-design.md) §13、Issue は #46（土台の実環境）と #44（ドメイン・公開境界）。先例は NIHO finance の配備（同じ本番プロジェクト・同じ共有 Cloud SQL・同じドメインマッピング）。

このリポジトリは公開なので、プロジェクト ID・プロジェクト番号・URL・バケット名は書かない。それらは手元の `scripts/editor-deploy/deploy.env`（`.gitignore` 済み。雛形は [`deploy.env.example`](../../scripts/editor-deploy/deploy.env.example)）に置き、スクリプトが読む。別の場所に置くときは `DEPLOY_ENV=/path/to/deploy.env scripts/editor-deploy/deploy.sh`。

## 1. 構成

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Run サービス | `niho-editor` | 画面と `/api/pages`。誰でも呼べる（ログインはアプリの中）。min 0 / max 2、`EDITOR_AUTH_MODE=niho` |
| Cloud Run ジョブ | `niho-editor-migrate` | 配備のたびに 1 回。migration の適用と、アプリ用ロールの作成・権限付与 |
| Cloud SQL | 既存の共有インスタンスに データベース `niho_editor` | ロール 2 つ: `niho_editor_migrate`（表の所有者。migrate ジョブだけが使う）と `niho_editor_app`（DML だけ。DDL と migration の記録の書き換えは不可） |
| GCS | 資産バケット（private） | 均一なバケットレベルのアクセス、公開アクセス禁止。実行 ID は作成と閲覧だけ（削除・上書き不可） |
| Secret Manager | `niho-editor-database-url`（アプリ）、`niho-editor-migrate-database-url`（migrate） | アプリは自分の URL だけ読める。migrate ジョブは両方読む（アプリ用ロールを作るため） |
| サービスアカウント | `niho-editor-runner`（画面）、`niho-editor-migrate`（ジョブ） | 別々にして、画面からは表の所有者の資格情報に届かないようにする |
| Artifact Registry | `niho-editor`（Docker） | 配備の image。直近 5 個だけ残す |
| Cloud Build | — | `scripts/editor-deploy/cloudbuild.yaml` で web と migrate の 2 つの image を 1 回で作る |

手順の実行基盤（Cloud Tasks のキュー・OIDC 用のサービスアカウント・Cloud Scheduler の掃除）は §10。

ラベルを付けられる資源は `app=niho-editor` を持つ。Cloud Billing のレポートでラベルに絞ると NIHO アプリと分けて見られる。

接続は finance と同じ。Cloud SQL は private IP だけなので、サービスとジョブは Direct VPC egress（`default` ネットワーク・`private-ranges-only`）に出て、Cloud SQL コネクタの Unix ソケットで接続する。`DATABASE_URL` は `postgresql://<role>:<password>@localhost/niho_editor?host=/cloudsql/<接続名>` の形（`pg` がソケットとして解釈する）。

## 2. 環境変数

| 変数 | 値 | 内容 |
| --- | --- | --- |
| `EDITOR_AUTH_MODE` | `niho` | 本番は `niho` 以外だと起動しない（[apps/editor-web/README.md](../../apps/editor-web/README.md)） |
| `EDITOR_ORIGIN` | `https://<APP_DOMAIN>` | 更新系の要求の `Origin` 検査。独自ドメインが無いうちは `run.app` の URL |
| `EDITOR_ASSETS_BUCKET` | 資産バケット名 | アプリはまだ読まない（画像と音声は #33 以降） |
| `DATABASE_URL` | Secret | アプリ用ロール |

手順（#37）の `EDITOR_STEPS_*` は `STEPS_MODE=cloud-tasks` のときだけ足す（§10）。

migrate ジョブには `DATABASE_URL`（migrate ロール）と `EDITOR_APP_DATABASE_URL`（アプリ用ロールの URL。ここからロール名とパスワードを取って作る）が Secret で渡る。

## 3. 初回だけ

`scripts/editor-deploy/gcp-bootstrap.sh resources` が冪等に作る（あるものは飛ばす）。パスワードは生成して Secret に入れ、ファイルにも画面にも出さない。

1. API の有効化
2. サービスアカウント 2 つと `roles/cloudsql.client`
3. Cloud SQL にデータベース `niho_editor` と migrate ロール（アプリ用ロールは migrate ジョブが作る）
4. Secret 2 つと、読める人の限定
5. Artifact Registry（直近 5 個だけ残す）
6. 資産バケット（private）
7. 手順の実行基盤（`scripts/editor-deploy/steps-infra.sh`。§10）

続けて `scripts/editor-deploy/deploy.sh`、そのあと `gcp-bootstrap.sh domain`（§6）。

## 4. 毎回の配備

```sh
scripts/editor-deploy/deploy.sh            # 現在の HEAD を配備する（clean な worktree で）
scripts/editor-deploy/deploy.sh --no-build # いま動いている image のまま配備し直す（Secret の新しい版を読ませる）
```

1. Cloud Build で web と migrate の image を作る（タグは git の SHA）
2. migrate ジョブを新しい image で実行して終わるまで待つ（失敗したら配備を止める）
3. `niho-editor` を新しい image で配備（env と Secret も毎回渡す）
4. smoke: `/`・`/api/pages`・`/robots.txt` が `X-Robots-Tag: noindex, nofollow` を返すこと、`/api/pages` がセッションなしで 401 を返すこと（`STEPS_MODE=cloud-tasks` なら、`/api/internal/steps/run`・`/sweep` が OIDC トークンなしで 401 を返すことも）

migration は expand → contract（列の削除は配備の 1 つ後）。適用済みのファイルは書き換えない（書き換えると migrate が止まる）。

## 5. ログイン（`niho` モード）が入るまでの状態

`niho` モードは niho-app #19459 の契約が出るまで fail-closed（いつも未認証）。それまで本番の `niho-editor` は起動して noindex を返すが、API は常に 401、画面はログインの前の状態のまま。つまり **誰もページを作れない**。これが想定した状態で、`stub` へ落とす経路は無い（`NODE_ENV=production` で `EDITOR_AUTH_MODE` が `niho` 以外だと port を開く前に終了する）。

## 6. 独自ドメインと TLS

画面サービスに Cloud Run のドメインマッピングを付ける（証明書は Google が発行・更新。追加費用なし。プレビュー機能なので、止まったときは `run.app` の URL で動く）。

1. ドメインの所有確認（Search Console）が gcloud のアカウントで済んでいること: `gcloud domains list-user-verified`
2. `scripts/editor-deploy/gcp-bootstrap.sh domain` — マッピングを作り、DNS に登録する record を表示する
3. DNS（Cloudflare）に表示された CNAME を **プロキシなし（DNS only）** で登録する
4. 証明書が出るまで待つ（数分〜1 時間）。`https://<APP_DOMAIN>/api/pages` が 401 と `X-Robots-Tag: noindex, nofollow` を返せば通っている

## 7. 本番の起点（公開境界）

[release-boundary.md](../architecture/release-boundary.md) の「公開 CI に本番秘密値・Cloud Run 権限を置かない。公開リポからの push で本番配備を直接起動しない」を守る。

- 公開 CI（[editor-web-ci.yml](../../.github/workflows/editor-web-ci.yml)）は secret なし・合成データ・GitHub-hosted runner で、型検査・テスト・build・image の build までを確かめる。
- 本番への配備は、権限のある gcloud ログインを持つオーナーが手元で `deploy.sh` を実行する。GitHub Actions からは配備しない（OIDC の Workload Identity も作らない）。
- 配備設定（`deploy.env`）は公開リポに置かない。

## 8. コストの見込み

| 項目 | 見込み |
| --- | --- |
| Cloud Run（min 0） | 0 円台。使った分だけ |
| Cloud SQL | 既存インスタンスに同居なので追加の固定費なし。共有なので、負荷が出たら分ける |
| GCS | 保存量しだい（いまは空） |
| Secret Manager（有効な版 6 つまで無料） | 0 円 |
| Artifact Registry（直近 5 個） | 10 円未満 |
| Cloud Build（1 日 120 分まで無料） | 0 円 |
| Cloud Tasks・Cloud Scheduler（手順。§10） | 月 15 円ほど（Scheduler 1 件） |

## 9. 戻し方

- 配備を戻す: 前の revision へ全トラフィックを戻す（`gcloud run services update-traffic niho-editor --to-revisions <revision>=100`）。DB は expand → contract なので旧版と互換。戻したあとの次のデプロイでは、`deploy.sh` が毎回 `update-traffic --to-latest` で最新の revision へ traffic を向け直す（Cloud Run は割り当てを引き継ぐため、これが無いと smoke が古い revision に通る）。
- サービスを止める: 独自ドメインのマッピングを消せば `run.app` の URL だけが残る。サービスごと止めるなら `gcloud run services delete niho-editor`（DB とバケットは残る）。

## 10. 手順の実行基盤（#37）

手順（記事制作・議事録・インサイト整理）の段階を、画面を閉じても進むようにサーバー側で実行する。方式は [editor-steps-execution.md](../architecture/editor-steps-execution.md) の B（§5.2 実行・§5.5 費用）。**この段階では実行器が偽物（`[fake]` の印を付けた決定的な結果。AI は呼ばない）なので、有効にしても本物の記事は作られない。** 本物の実行器は後段で、差し替える所は `apps/editor-web/src/server/steps-deps.ts` の 1 か所。

### 構成

```text
画面 ── POST /api/pages/{id}/steps/runs ──▶ niho-editor（受付: run を作り、最初の段階を積む）
                                               │ tasks.create（名前 = <run>-<段階>-<世代>。同じ名前は ALREADY_EXISTS ＝積み済み）
                                               ▼
                                  Cloud Tasks キュー niho-editor-steps
                                               │ POST /api/internal/steps/run（OIDC: niho-editor-tasks、audience = run.app の URL）
                                               ▼
                                  niho-editor の内部の route（同じサービス）: claim → 実行 → 確定 → 次の段階を積む

Cloud Scheduler niho-editor-steps-sweep ── 5 分おき POST /api/internal/steps/sweep（同じ OIDC）──▶ niho-editor
    lease の切れた段階と、queued のまま残った段階を、同じ名前の規則で積み直す（積み済みなら重複で無視される）
```

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Tasks キュー | `niho-editor-steps` | 最大 5 回・10〜300 秒の間隔で再試行・同時 5 本。1 つの task は最大 30 分（`dispatchDeadline`） |
| サービスアカウント | `niho-editor-tasks`（deploy.env の `TASKS_SA`） | task と掃除の OIDC トークンの身元だけ。**どの資源の権限も持たない** |
| Cloud Scheduler | `niho-editor-steps-sweep` | `*/5 * * * *`（Asia/Tokyo）・試行の期限 300 秒・再試行なし |
| 権限 | 実行 ID（`niho-editor-runner`） | キューへの `roles/cloudtasks.enqueuer` と、`niho-editor-tasks` への `roles/iam.serviceAccountUser`（task に OIDC を付けるため） |

サービスは誰でも呼べる設定のまま（invoker の IAM は使わない）なので、worker の route が自分で Google の ID トークンを検証する（`apps/editor-web/src/server/google-oidc.ts`）: アルゴリズムは RS256 だけ、鍵は Google の JWKS（固定の URL）、`iss` は Google、`aud` は run.app の URL と完全一致、期限は時計のずれ 60 秒まで、`email` は `niho-editor-tasks` と完全一致かつ確認済み。通らない要求は本文を読まずに 401、`Origin` の付いた要求（ブラウザ）は 403。キュー・サービスアカウント・Scheduler のジョブはラベルを付けられない（費用は §8 のとおり小さい）。

`deploy.sh` が足す環境変数（`STEPS_MODE=cloud-tasks` のときだけ。3 つが揃い形が正しいときだけアプリは手順を開く。欠ければ手順の開始は 503、worker の route は 404）:

| 変数 | 値 |
| --- | --- |
| `EDITOR_STEPS_MODE` | `cloud-tasks` |
| `EDITOR_STEPS_QUEUE` | `projects/<project>/locations/<region>/queues/niho-editor-steps` |
| `EDITOR_STEPS_WORKER_URL` | サービスの run.app の URL（独自ドメインではない。OIDC の audience にも使う） |
| `EDITOR_STEPS_INVOKER_SA` | `niho-editor-tasks@<project>.iam.gserviceaccount.com` |

### 有効にする

1. `scripts/editor-deploy/gcp-bootstrap.sh resources`（中で `steps-infra.sh` を呼ぶ。`scripts/editor-deploy/steps-infra.sh` だけでもよい）: API・キュー・サービスアカウント・権限・Scheduler を冪等に作る（あるものは更新）。Scheduler は作った時から 5 分おきに呼ぶが、次の 2 つが済むまでは worker の route が 404 を返す（ジョブの失敗として残るだけで、再試行しない）。
2. `deploy.env` に `STEPS_MODE=cloud-tasks`
3. `scripts/editor-deploy/deploy.sh`（コードが同じなら `--no-build`）: 環境変数を足し、smoke で worker の route が OIDC トークンなしで 401 を返すことを確かめる。

### 無効にする

1. `deploy.env` の `STEPS_MODE` を空にして `deploy.sh --no-build`（手順の開始は 503、worker の route は 404 になる）。
2. 掃除を止める: `gcloud scheduler jobs pause niho-editor-steps-sweep --location <region>`（戻すときは `resume`）。`steps-infra.sh` を流し直しても、止めた状態は保たれる。
3. 積まれている task を止めるなら `gcloud tasks queues pause niho-editor-steps --location <region>`（任意。止めなくても worker の route が 404 を返し、5 回の試行で消える。段階は queued のまま残り、有効にし直すと掃除が拾う）。

### 費用

| 項目 | 見込み |
| --- | --- |
| Cloud Tasks | 月 100 万回まで無料。1 つの段階で 1 回（再試行・掃除の積み直しも 1 回）。無料の範囲 |
| Cloud Scheduler | ジョブ 1 件で月 15 円ほど |
| Cloud Run | 5 分おきの掃除で、使われていなくても 1 日 288 回起こす。1 回は DB の問い合わせ 2 つで短いので、無料の範囲 |

### 失敗の見方

- **Cloud Tasks のキュー**（コンソールの Cloud Tasks → `niho-editor-steps`）: 積まれている数と試行の回数。worker の route が 200 以外を返した task は 5 回まで試され、その後消える。段階は queued のまま残り、掃除が拾う（ただし Cloud Tasks は同じ名前を最大 24 時間使わせないので、拾われるのはその後）。
- **Cloud Run のログ**（短い code だけ。トークン・本文・クレームの値は出さない）:
  - `editor-web: worker request refused`: 検証に通らなかった（`code` は `missing_token`・`bad_audience`・`bad_email`・`expired`・`bad_signature`・`jwks_unavailable` など）。Scheduler・Cloud Tasks からの要求でこれが出るなら、`EDITOR_STEPS_WORKER_URL` と `--oidc-token-audience`、`TASKS_SA` の食い違いを疑う。
  - `editor-web: request failed`（500）: `code` は `tasks_http_<status>`（Cloud Tasks の拒否。403 なら実行 ID の権限）・`tasks_token_*`（メタデータサーバー）・DB の code。Cloud Tasks が同じ task を再試行する。
  - `editor-web: sweep could not requeue every step`: 掃除の積み直しの一部が失敗した（次の回でまた拾う）。
- **段階の失敗の理由**: 帯（`GET /api/pages/{id}/steps` の `errorCode`）。`lease_expired` は実行中に worker が落ちて lease が切れたもの。
- **Cloud Scheduler のジョブ**の最後の実行: 成功は 200 `{"requeued": n}`。

### 制約

- 1 つの段階は 1 回の要求。今の `deploy.sh` の Cloud Run の要求の上限（`--timeout 60`）を超える段階は途中で切れる（Cloud Tasks が再試行し、lease が切れれば掃除が拾う）。偽物の実行器はすぐ終わるので今は当たらない。本物の実行器をつなぐ段で、段階の長さに合わせて上げる（上限は task の 30 分）。
