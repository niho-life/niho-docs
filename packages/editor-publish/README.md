# @niho/editor-publish

editor の公開のシート（#39）の裏で動く判定と状態遷移。仕様の正本は [editor-publish-core.md](../../docs/architecture/editor-publish-core.md)、公開版の形と読み取り API は [editor 公開 API contract v1](../../docs/security/editor-publish-api-v1.md)（[`@niho/editor-publish-contract`](../editor-publish-contract/)）、画面と役割は [editor-niho-life-design.md](../../docs/architecture/editor-niho-life-design.md) §8・§10・§12。

純粋な TypeScript で、依存は `@niho/editor-publish-contract` だけ（Node 24 と標準の Web Crypto）。DB・HTTP・NIHO の役割・時計・資産の置き場はポートで受け取る。

## 持つもの

| モジュール | 内容 |
| --- | --- |
| `declaration` | 発信先の宣言の検証（閉じた語彙。未知の `kind`・フィールド・型の違いは宣言ごと拒否） |
| `readiness` | `collectFacts` と `evaluateReadiness`（公開の前に：`problems` と `notices`） |
| `slug` | `slugFromTitle`・`validateSlug`・`suggestSlug` |
| `snapshot` | TipTap の本文 → 契約の AST、公開版（`buildSnapshot`、契約で自己検証して freeze）、`fingerprint` |
| `status` | `deriveStatus`（`ShellStatusState` と同じ語）と `sheetPlan`（`problems` があれば主ボタンは `null`） |
| `redirects` | NIHO の面の転送（`resolveRedirect` は最大 8 段、輪は一覧。鎖は 1 段に保つ） |
| `service` | `PublishService`：`publish`・`update`（保存を含む）・`stop`・`changeDestination`。各操作は 1 トランザクション |

## ポート

| ポート | 役目 |
| --- | --- |
| `PublishStore` / `PublishTx` | ページ・資産・公開・公開版・転送。失敗したら全部元に戻すトランザクション |
| `RoleReader` | NIHO の役割を操作のたびに読む（保存しない） |
| `ConnectionSource` | 本人のサイトの接続があるか（接続の実体は #41） |
| `DeclarationSource` | 発信先の宣言 JSON（検証はこのパッケージ） |
| `AuthorSource` | 公開した時点の著者 |
| `FactsSource` | 関連する体験が掲載中か（`null` は満たさない） |
| `AssetUrls` | 資産の https URL |
| `Clock` | 時刻 |

## 持たないもの

Postgres の実装、HTTP の経路、宣言の取得、NIHO からの役割の読み取り、接続・鍵・書き出し（#41）、シートの React 実装。

`test-support/memory-store.ts` はテスト用のメモリ実装で、本番では使わない。

```sh
npm ci
npm run check   # typecheck + tests
```
