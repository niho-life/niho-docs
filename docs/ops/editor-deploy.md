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

ラベルを付けられる資源は `app=niho-editor` を持つ。Cloud Billing のレポートでラベルに絞ると NIHO アプリと分けて見られる。

接続は finance と同じ。Cloud SQL は private IP だけなので、サービスとジョブは Direct VPC egress（`default` ネットワーク・`private-ranges-only`）に出て、Cloud SQL コネクタの Unix ソケットで接続する。`DATABASE_URL` は `postgresql://<role>:<password>@localhost/niho_editor?host=/cloudsql/<接続名>` の形（`pg` がソケットとして解釈する）。

## 2. 環境変数

| 変数 | 値 | 内容 |
| --- | --- | --- |
| `EDITOR_AUTH_MODE` | `niho` | 本番は `niho` 以外だと起動しない（[apps/editor-web/README.md](../../apps/editor-web/README.md)） |
| `EDITOR_ORIGIN` | `https://<APP_DOMAIN>` | 更新系の要求の `Origin` 検査。独自ドメインが無いうちは `run.app` の URL |
| `EDITOR_ASSETS_BUCKET` | 資産バケット名 | アプリはまだ読まない（画像と音声は #33 以降） |
| `DATABASE_URL` | Secret | アプリ用ロール |

migrate ジョブには `DATABASE_URL`（migrate ロール）と `EDITOR_APP_DATABASE_URL`（アプリ用ロールの URL。ここからロール名とパスワードを取って作る）が Secret で渡る。

## 3. 初回だけ

`scripts/editor-deploy/gcp-bootstrap.sh resources` が冪等に作る（あるものは飛ばす）。パスワードは生成して Secret に入れ、ファイルにも画面にも出さない。

1. API の有効化
2. サービスアカウント 2 つと `roles/cloudsql.client`
3. Cloud SQL にデータベース `niho_editor` と migrate ロール（アプリ用ロールは migrate ジョブが作る）
4. Secret 2 つと、読める人の限定
5. Artifact Registry（直近 5 個だけ残す）
6. 資産バケット（private）

続けて `scripts/editor-deploy/deploy.sh`、そのあと `gcp-bootstrap.sh domain`（§6）。

## 4. 毎回の配備

```sh
scripts/editor-deploy/deploy.sh            # 現在の HEAD を配備する（clean な worktree で）
scripts/editor-deploy/deploy.sh --no-build # いま動いている image のまま配備し直す（Secret の新しい版を読ませる）
```

1. Cloud Build で web と migrate の image を作る（タグは git の SHA）
2. migrate ジョブを新しい image で実行して終わるまで待つ（失敗したら配備を止める）
3. `niho-editor` を新しい image で配備（env と Secret も毎回渡す）
4. smoke: `/`・`/api/pages`・`/robots.txt` が `X-Robots-Tag: noindex, nofollow` を返すこと、`/api/pages` がセッションなしで 401 を返すこと

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

## 9. 戻し方

- 配備を戻す: 前の revision へ全トラフィックを戻す（`gcloud run services update-traffic niho-editor --to-revisions <revision>=100`）。DB は expand → contract なので旧版と互換。
- サービスを止める: 独自ドメインのマッピングを消せば `run.app` の URL だけが残る。サービスごと止めるなら `gcloud run services delete niho-editor`（DB とバケットは残る）。
