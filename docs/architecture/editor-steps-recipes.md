# 手順（#37 T4）: 工程設計の引き継ぎ・手順の正本・設計の画面

状態: **設計の提案（実装前）**。Issue #37、設計 [editor-niho-life-design.md](editor-niho-life-design.md) §7.2、実行基盤 [editor-steps-execution.md](editor-steps-execution.md)。

旧 NIHO docs の工程設計（`packages/docs-core`）を editor.niho.life へ引き継ぐときの、(1) 手順の正本をどこに置くか、(2) 段階の実行からサブページの生成までで何が足りないか、(3) 手順を作る・直す画面をどこに置くか、(4) 旧アプリから落としてはいけない振る舞い、の 4 つを決める。コードは含まない。

実装の前提として **T1（`recipes` の表）と T5（本物の実行器）**を待つ。この文書はその 2 つと噛み合う形を決めるためのもの。

## 0. 要点

| 問い | 答え |
| --- | --- |
| 手順の正本 | **`recipes` の表 1 つ**に寄せる。いま正本が `editor_settings.recipes`（jsonb・migration 0013）と T1 の `recipes` の表で**二重になる**ので、0021 で移して列を使わなくする。差し替えは `RecipeReader` の 1 か所（§1.2） |
| 実行 → サブページ | **実行の制御は完成している**（世代・lease・1 transaction の確定・掃除・取消・決定的なサブページ id・帯）。足りないのは**実行器の中身と入力の組み立て**で、8 件（§2.2） |
| 設計の画面 | **新しい画面を作らない。**設定の「手順」の節（#108 で入った）に足す。足すのは**お手本の文書の取り込みと文書ガイドの抽出**・並べ替え・手順ごとの固有名詞（§3） |
| 落としてはいけない振る舞い | 14 件（§4）。いちばん重いのは**入力の規則**（段階 N は上流の**全部**の成果物を読む。いまは直前の 1 つだけ）と**前提変更の理由**（いまは理由を持たない） |

いちばん大きな発見を 2 つ先に書く。

1. **手順の編集の画面は、もう有る。** #108（PR #110）が設定に「手順」の節を作り、段階の名前・指示・お手本（文書ガイド）の編集、段階の追加・削除、手順の複製・追加・削除・既定に戻す、までを実装済み。§7.2 が言う「設定の『手順』で編集・追加・複製できる」は満たしている。T4 が作るのは**その節の続き**で、別の画面ではない。
2. **実行の仕組みは完成しているが、段階に渡している入力が足りない。** `readStepInput` は「録音ページ ＋ 直前の段階のサブページ」の 2 つだけを返す。docs-core の入力の規則（`inputs.ts` の `inputsFor`）は「原文 ＋ **段階 1〜N−1 の全部**の成果物 ＋ 参考ページ ＋ 背景情報 ＋ 文書ガイド」。記事制作の「記事本文」が「記事方針」だけを見て「文字起こし修正」を見ないので、**いまの形のまま本物の AI を繋ぐと記事の質が落ちる**。T5 より先にここを直す。

---

## 1. docs-core の工程設計を `recipes` の表にどう載せるか

### 1.1 いま手順はどこにあるか（正本が 2 つになる）

| 置き場 | 入っているもの | 状態 |
| --- | --- | --- |
| `packages/docs-core/src/templates.ts` の `FLOW_TEMPLATES` | 既定の 4 つのテンプレート（記事制作・議事録・インサイト整理・コーチング）の**指示文の正** | main に有り。editor は `tpl-1`〜`tpl-3` の 3 つを `DEFAULT_RECIPES` に写している（`apps/editor-web/src/steps/recipes.ts`） |
| `editor_settings.recipes`（jsonb。migration 0013） | 既定に手を入れた写しと、足した手順（`{ id, name, guide, steps: [{ id, name, instruction }] }`） | **main に有り。設定の画面・受付 API・worker が既に読み書きしている** |
| `recipes` の表（T1 の `0021_recipes.sql`） | 工程・プロファイル・guide・固有名詞・お手本 | 作成中 |

`editor_settings.recipes` が既に動いているので、T1 の表が入ると**同じものの正本が 2 つになる**。放っておくと、設定の画面が jsonb を書き、実行が表を読む（またはその逆）形になり、「設定で直したのに実行に効かない」が起きる。

### 1.2 判断: `recipes` の表を正本にし、`RecipeReader` の 1 か所で差し替える

**理由。** 表に移す理由は 1 つだけで、**お手本の文書（`samples`）の本文を入れるため**。docs-core の上限は 1 本 30,000 字 × 5 本（`rules.ts` の `SAMPLE_MAX_CHARS`・`SAMPLE_MAX_COUNT`）＝ 手順 1 つで最大 150KB。これを `editor_settings` の jsonb に入れると、**`GET /api/pages/{id}/steps` が数秒おきに読む**（前提変更の測り直しで `deps.recipes()` を呼ぶ）行が最大 3MB（手順 20 個分）になる。帯を開いている間ずっとそれを引くのは割に合わない。固有名詞と revision も表の方が素直に入る。

**移すときの救い**は、`recipes.ts` が既に `RecipeReader = (owner) => Promise<readonly RecipeDef[]>` という口を切っていること。置き場を替えても変わるのは `apps/editor-web/src/server/steps-deps.ts` の `ownerRecipes()` **1 関数**で、受付 API・worker・runner・画面は触らない（#108 がこの口を作ってくれた形がそのまま効く）。

**`samples` は hot path から外す。** お手本の本文は `recipe_samples`（別の表か、同じ表の別の列）に置き、`RecipeDef` には**名前と字数だけ**を載せる。本文を読むのは (a) 文書ガイドの抽出のとき、(b)（もし入力に入れるなら）段階の実行のとき、の 2 つだけ。帯の polling では読まない。

### 1.3 docs-core の `Flow` と `recipes` の表の対応

| docs-core `Flow` | `recipes` に載せるか | 理由 |
| --- | --- | --- |
| `id`・`name` | 載せる | そのまま |
| `revision`（保存のたびに増える） | **載せる** | §4 の「手順を直しても既存の録音は変わらない」（snapshot）に要る |
| `guide`（文書ガイド。Markdown） | 載せる（既に `editor_settings` に有る） | 全段階の入力に入る |
| `terms`（手順ごとの固有名詞 4 列） | **載せる** | いま editor はアカウント共通の `editor_settings.glossary` だけ。docs-core は手順ごとと案件ごとの 2 段。§3.3 で相談 |
| `samples`（お手本の文書） | 載せる（本文は別の表） | §1.2 |
| `transcription`（先頭に文字起こし工程を含むか） | **載せない** | editor は録音ページの下にサブページを作る形で、文字起こしは #36 の別経路。手順の段階に文字起こしは含まれない（`recipes.ts` の既定 3 つも含まない） |
| `steps[].id`・`name`・`instruction` | 載せる | そのまま |
| `steps[].profile`・`provider`（モデル × 思考量） | **載せない** | editor はモデルと鍵をサーバー側だけに置く設計（`apps/editor-web/src/ai/config.ts` の `resolveAiBackend(env)`、設計 §6）。段階ごとに提供元を選ぶ UI も持たない。docs-core の `Profile`・`ResolvedStepModel`・`FlowSnapshot.models` は editor には要らない |

**`ProjectInfo`（背景情報・登場人物・話者人数・言語）は手順ではなく録音ページ側**。いま editor の録音ページはこれを持たない（§2.2 G）。

### 1.4 T1 へのお願い（表を作る側に渡すこと）

1. `recipes` は **owner ごと**（`owner text` + `id text` の複合主キー）。既定の 3 つは行を作らず、**手を入れたものと足したものだけ**が行になる（いまの jsonb と同じ考え。`recipesOf()` が既定にかぶせる）。
2. `0021` で **`editor_settings.recipes` の中身を `recipes` の行へ移す**（jsonb → 行）。列はその migration では落とさず残し、読まなくする（切り戻しのため）。落とすのは次の節目で。
3. お手本の本文は `recipes` の行に入れない（§1.2）。
4. 上限は docs-core と editor で食い違っているので、**表の CHECK は editor 側の値に合わせる**。食い違い: 文書ガイド 20,000 字（editor）対 4,000 字（docs-core `GUIDE_MAX_CHARS`）、段階 12（editor）対 32（docs-core `FLOW_MAX_STEPS`）。値の正は `packages/editor-store/src/settings.ts` の `SETTINGS_LIMITS` 1 か所のままにする。
5. 新しい表を足したら `packages/editor-store/test/store.integration.test.ts` の `documented` の一覧にも足す（忘れると CI が落ちる。#108 が 1 回踏んでいる）。

T1 が別の形で先に入った場合は、T4 が `ownerRecipes()` をその形に合わせる。**表の形の相談は T1 の PR で行い、T4 は migration の番号を取らない。**

---

## 2. 段階の実行 → サブページの生成

### 2.1 出来ていること（変えない）

`[editor-steps-execution.md](editor-steps-execution.md)` §5 の方式 B は**ほぼ実装が終わっている**。

| 仕組み | 実体 |
| --- | --- |
| 表と状態遷移 | `step_runs`・`step_attempts`（migration 0006）。`pages.step_status` に `failed` も有り |
| 受付 API | `apps/editor-web/src/server/steps-api.ts`（`GET /steps`・`POST /steps/runs`・`cancel`）。未認証 401、他人・無しは同じ 404、冪等キー対応 |
| 世代で守る確定 | `claimAttempt` が世代を進めて lease を取り、`commitAttempt`・`failAttempt` が世代で fence。遅れて返った結果で上書きしない |
| 1 transaction の確定 | `commitAttempt`: サブページの本文の差し替え ＋ 古い本文を版（`ai`）に残す ＋ `revision` を進める（#58 の楽観ロックで人の保存と競合する）＋ 次の段階を `queued` ＋ 最後なら run を `succeeded` |
| 決定的なサブページ id | `stepPageId(parent, recipe, stepIndex)`（sha256 → UUID v5 の形）。作り直しても同じページ |
| サブページの題名 | `createRun` が段階の名前で作る（`INSERT INTO pages … kind = 'step'`） |
| 生存確認と再開 | `heartbeatAttempt`（lease の 1/3 おき）、`sweepExpiredLeases`・`listQueuedAttempts`・`requeueAttempt` と Scheduler の掃除（#118 で「消えた task」と「積まれている task」を区別する修正済み） |
| 再試行 | 一時的な失敗は試行 3 回まで（自動の再試行は 2 回。`MAX_TRIES`）、間隔は指数的（`defaultRetryDelaySeconds`）。入力の誤りはすぐ失敗 |
| キュー | `cloud-tasks.ts`（本番）・`inline.ts`（開発・CI。本番では受け付けない） |
| 画面 | PR #114: 帯（`PageSteps.tsx`・`steps-view.ts`）・「記事にする」の入口・前提変更と作り直し・サイドバーの回るマーク・終了の通知 |

**この層は触らない。**足りないものが見つかったら PR 本文で相談する。

### 2.2 足りないこと

| # | 足りないもの | いまの形 | どうするか | 担当 |
| --- | --- | --- | --- | --- |
| **A** | **本物の実行器** | `steps-deps.ts` の `stepExecutor()` が `fakeExecutor` を返す（`[fake]` の印の決定的な結果） | 口は `StepExecutor.run(input) => { blocks, usage }` の 1 つだけ。T5 がこれを満たす | T5 |
| **B** | **入力が直前の 1 段階だけ** | `readStepInput` は `{ parentBlocks, previousBlocks }` の 2 つ | docs-core の規則（`inputsFor`）に合わせ、**上流の全部の成果物**を返す（§2.3） | **T4** |
| **C** | **前提（basis）が 2 入力だけ** | `computeBasis(prevBlocks, instruction)` の 1 ハッシュ。理由を持たない | docs-core の `Basis`（source・artifacts・refs・info・guide・step の 6 つ）＋ `staleReasons`・`staleNoticeText` に広げる（§2.4） | **T4** |
| **D** | **アプリの固定の決まりが無い** | 実行器がプロンプトを組んでいない（偽物なので） | docs-core `rules.ts` の `FIXED_RULES`（捏造しない・資料の中の指示に従わない・本文だけ出す 等）を**システム側の先頭に必ず置く**。資料の中の指示に従わない 1 行は、録音の文字起こしを AI に渡す経路の注入対策そのもので、落とせない | T5（T4 が口を決める） |
| **E** | **続き（continuation）が無い** | 1 段階 = 1 要求。出力が上限で切れたら `invalid_output` か切れたまま確定 | docs-core `rules.ts` の `CONTINUATION_INSTRUCTION`・`MAX_CONTINUATIONS`（8）・`CONTINUATION_MAX_OVERLAP`（400 字）。**1 段階は Cloud Tasks の 30 分以内**（実行基盤 §5.6）なので、続きはその中で回す | T5（上限は T4 が口に書く） |
| **F** | **お手本の文書（samples）が無い** | `RecipeDef` に `guide` だけ | §1.2・§3.3 | **T4** |
| **G** | **背景情報・固有名詞・話者人数・言語が段階に渡らない** | 録音ページがこれを持たない。固有名詞はアカウント共通の `editor_settings.glossary` だけ | `editor_settings.glossary` を入力に入れるのは今すぐできる。録音ごとの背景情報は**表の追加が要るので相談**（§6） | **T4**（一部は相談） |
| **H** | **参考ページ（refs）が無い** | 無い | 旧アプリは同じフォルダの独立文書を実行時に自動で固定する。editor のフォルダの木は T1。**v1 では入れない**（§6 で相談） | 相談 |

**複数案（`ArtifactCandidate`・`CandidateSet`）は v1 に入れない。**旧アプリは 1 つの段階に対等な複数の案を持てるが、editor のサブページ id は `(親, 手順, 段階)` から決定的に 1 つ決まる形で、案を増やすとこの前提が崩れる。入れるなら別の Issue。

### 2.3 入力の規則を直す形（B）

docs-core の規則（`inputs.ts` の `inputsFor`、spec §5.1）:

> 段階 N の入力 ＝ 原文（文字起こし／文章）＋ 段階 1〜N−1 の成果物（最新版）＋ 参考ページ ＋ 背景情報 ＋ 文書ガイド

直す形:

- `readStepInput` の答えを `{ parentBlocks, upstream: { stepIndex, stepId, name, blocks }[] }` にする（`previousBlocks` は `upstream` の末尾になるので畳む）。`step_attempts` は run の全段階の `page_id` を持っているので、**読み出しは 1 問い合わせのまま**（`page_id` の配列で `pages` を引く）。
- `StepExecutorInput` に `upstream` と `guide`・`glossary` を足す。`recipe` は既に渡っているので `guide` はそこから取れる。
- 上流のサブページが**人に消されていた**ら、その段階は空として渡す（止めない）。基準の計算では空文字として扱う（docs-core `basisFor` が `materials.artifacts[step.id] ?? ""` を hash するのと同じ）。

これは `packages/editor-store/src/step-runs.ts` の読み出し 1 関数と `apps/editor-web/src/steps/executor.ts` の型の変更で、**実行の制御（世代・lease・確定）には触らない**。

### 2.4 前提（basis）を docs-core の形に広げる（C）

いま `step_attempts.input_basis` は 64 文字の sha256 1 つで、`refreshStale` はそれが一致するかだけを見る。これで「前提変更」の印は出せるが、**何が変わったのか**を言えない。

旧アプリは `staleNoticeText` で本文の上に 1 行出す: 「元の文字起こしが変わりました。」「背景情報が変わりました。」「文書ガイドが変わりました。」「工程の指示が変わりました。」。**これは落とせない**（§4）。帯が「前提変更」とだけ言って、何を直したせいか分からないのは、作り直すかどうかを決められない。

直す形:

- `input_basis` を**項目ごとのハッシュを持つ jsonb** にする（docs-core の `Basis` と同じ形: `source`・`artifacts`・`info`・`guide`・`step`、`refs` は持たない）。
- 比較は docs-core の `staleReasons` を**そのまま使う**（純粋な関数で、editor の `Block[]` を hash した文字列を入れるだけ）。文言も `staleNoticeText` をそのまま使う。
- `refreshStale` は `boolean` ではなく**理由**を返し、`GET /api/pages/{id}/steps` の答えに段階ごとの理由を載せる。帯は**色だけで状態を表さない**（文字で理由を出す）ので、むしろ要件に素直。
- 列の型が変わるので **migration が 1 つ要る**（§6 で相談。番号は取らない）。

**互換**: 既存の 64 文字の文字列が入っている行は「記録が無い」として扱い、前提変更にしない（docs-core の `staleReasons` が `recorded` 無しで `[]` を返すのと同じ）。既に出荷している帯を、移行の瞬間に全部「前提変更」にしない。

---

## 3. 設計の画面（手順そのものを作る・直す画面）

### 3.1 判断: 新しい画面を作らない。設定の「手順」の節に足す

設計 §7.2 は「**手順の中身（段階の名前、指示、お手本）は設定の「手順」で編集・追加・複製できる。お手本の文書や URL からの抽出は NIHO docs の工程設計を引き継ぐ。**」と書いている。前半は #108 で**もう入っている**。T4 がやるのは後半。

旧アプリは「工程設計」を独立した画面に持っていたが、editor で分ける理由が無い。手順は**アカウントに 1 組**（録音ごとでも案件ごとでもない）で、変えるのは稀な設定の操作。設定の中にあれば、固有名詞（同じく全段階に効く）と並んで見える。狭い画面でも並びが同じで戻る先が画面のまま、という #108 の方針もそのまま効く。

### 3.2 いま出来ること（#108・PR #110 で入った）

`packages/docs-ui/src/shell/editor-settings.tsx` の「手順」の節（`es-s-steps`）:

- 手順の一覧（「文字起こし › 文字起こし修正 › 記事方針 › 記事本文」のように段階を並べて見せる）。手を入れた手順には「手を入れています」の印
- 1 つの手順を**その場で開いて編集**: 手順の名前・お手本（全段階に渡す文書ガイド）・段階ごとの名前と指示
- 段階の追加・削除（**足した手順だけ**。既定の手順は段階の数を変えられない。「できあがったページがその段階に結んでいます」＝決定的なサブページ id を守るため）
- 手順の複製・追加・削除・既定に戻す
- 上限の表示（手順 20・段階 12）

### 3.3 足すもの

| 足すもの | docs-core の正 | 備考 |
| --- | --- | --- |
| **お手本の文書の取り込み** | `types.ts` の `FlowSample`、`rules.ts` の `SAMPLE_MAX_COUNT`（5）・`SAMPLE_MAX_CHARS`（30,000） | ファイル（.md・.txt・.docx・.pdf）と **URL** から本文を取る。旧アプリは Rust（`src-tauri/src/samples.rs`）で抽出していたので、**サーバー側の抽出を新しく書く**。長い文書は段落の切れ目まで（`truncatedFrom` に元の字数） |
| **文書ガイドの抽出** | `guide-extraction.ts`（`GUIDE_EXTRACTION_RULES`・`buildGuideExtractionPrompt`・`parseGuideExtraction`・`mergeExtractedTerms`・`sampleStats`） | お手本から 6 見出しの文書ガイドと固有名詞の候補を AI に作らせる。**純粋な部分は全部 docs-core に有るので、サーバーで呼ぶだけ。**置き換える前に画面で確かめ、固有名詞は今の一覧に無い語だけを足す。候補に残す最小の出現回数は 3（`GUIDE_TERM_MIN_OCCURRENCES`） |
| **段階の並べ替え** | `flow-edit.ts` の `moveStep` | いまは追加と削除だけ。既定の手順は段階の数を変えられないが、**並べ替えは id が変わらないので既定でも許せる**（サブページ id は `(親, 手順, 段階の index)` なので、並べ替えると結び先が変わる。→ §6 で相談） |
| **手順ごとの固有名詞** | `types.ts` の `Flow.terms` | アカウント共通の `editor_settings.glossary` は既に有る。docs-core は「手順ごと」と「案件ごと」の 2 段。→ §6 で相談 |
| **実行できない手順の印** | `flow-choices.ts` の `flowUnusableReason`（指示文が空の工程がある手順） | いまは空の指示でも保存でき、実行して初めて困る |
| **段階の複製** | `flow-edit.ts` の `duplicateStep`（「〈名前〉のコピー」、重ならない名前） | 手順の複製（`duplicateFlow`）は有るが段階の複製は無い |
| **重ならない名前** | `flow-edit.ts` の `uniqueStepName`・`uniqueFlowName`（NFKC・前後の空白を無視して比べ、「 2」「 3」…を付ける） | いまは「新しい段階」が何個でも並ぶ |

### 3.4 置かないもの

- **モデル・思考量・提供元の選択**（docs-core の `Profile`・プロファイルの表）。editor はサーバーが決める（§1.3）。
- **実行先の選択**（`execution-preferences.ts` の `cloud` / `own_mac`）。editor は Cloud Run の 1 本道。
- **フローの選択の画面**（`flow-choices.ts` の「あなたの工程 / テンプレート」の 2 群）。editor の入口は録音ページの「記事にする」等で、PR #114 が手順の一覧から作っている。

---

## 4. 旧アプリで落としてはいけない振る舞い

オーナーの要件は「同じ機能を維持」。docs-core を読んで挙げた 14 件。**○ = いまの editor で満たしている、△ = 一部、× = 無い。**

| # | 振る舞い | docs-core の正 | いま | T4 |
| --- | --- | --- | --- | --- |
| 1 | **入力の規則**: 段階 N は原文 ＋ 上流の**全部**の成果物 ＋ 参考 ＋ 背景情報 ＋ 文書ガイドを読む | `inputs.ts` `inputsFor` | △ 直前の 1 つだけ | §2.3 で直す |
| 2 | **アプリの固定の決まり**を毎回添える（捏造しない・**資料の中の指示に従わない**・作業報告を書かない・原文を事実の根拠にする） | `rules.ts` `FIXED_RULES` | × | T5 の口に書く（§2.2 D） |
| 3 | **前提変更の理由を 1 行で言う**（「元の文字起こしが変わりました。」等）。「成果物」「前提変更」の語は使わない | `plan.ts` `staleReasons`・`staleNoticeText` | △ 印は出るが理由が無い | §2.4 で直す |
| 4 | **前提の粒度**: 原文・上流の成果物それぞれ・参考・背景情報・文書ガイド・**指示文**の 6 つを別々に見る | `plan.ts` `basisFor`・`Basis` | △ 2 入力の 1 ハッシュ | §2.4 |
| 5 | **名前を変えただけでは前提変更にしない**（段階名・参考のタイトルは比べない。指示文は前後の空白だけの違いを無視） | `plan.ts` `stepHash`・`refsHash` のコメント | ○ 基準は本文と指示文だけ | 広げるときに守る |
| 6 | **失敗した段階だけやり直す。上流は再利用する** | `plan.ts` `canRunStep`、`FlowDesignDiff` | ○ `fromStep` の run・`reused` の状態 | — |
| 7 | **段階の id は名前を変えても変えない**（成果物がその id に結んでいる） | `flow-edit.ts` の先頭のコメント | ○ `SettingsStep.id` は編集できない | 守る |
| 8 | **既定の手順に手を入れたら、既定に戻せる** | テンプレートが指示文の正 | ○ #108 の「既定に戻す」 | — |
| 9 | **手順の複製**（名前・文書ガイド・固有名詞・お手本・段階を写し、重ならない名前、revision 1） | `flow-edit.ts` `duplicateFlow` | △ 複製は有るが固有名詞とお手本が無い | §3.3 |
| 10 | **お手本の文書から文書ガイドを抽出**（6 見出し ＋ 固有名詞の候補。置き換える前に確かめる） | `guide-extraction.ts` | × | §3.3 |
| 11 | **出力が上限で切れたら続きを頼む**（重複せず止まった箇所の直後から。8 回まで、重なり 400 字まで） | `rules.ts` `CONTINUATION_*`・`MAX_CONTINUATIONS` | × | T5（§2.2 E） |
| 12 | **途中までの出力を捨てない**（版にせず checkpoint に残す） | `types.ts` `RunCheckpoint` | × 失敗すると何も残らない | **v1 では入れない**（§6） |
| 13 | **手順を直しても、既にできている録音の結果は勝手に変わらない**（録音が作成時の写しを持つ） | `types.ts` `FlowSnapshot`、`Recording.flowSnapshot` | × run は claim のときの定義で続くが、**作り直すと新しい定義になる** | §6 で相談 |
| 14 | **手順を直したら、何が変わるかを見せてから更新する**（増えた・消えた・名前・指示文・並び・文書ガイドの違い） | `flow-edit.ts` `diffFlowDesign`・`FlowDesignDiff` | × | 13 と一組。§6 |

13 と 14 は一組で、**v1 に入れるかどうかがオーナー判断**。旧アプリは「録音ごとに作成時の工程の写しを固定し、『この録音の工程を今の設計に更新』で明示的に更新する」形だった。editor は「手順を変えると次に始めたときから効く」と割り切っている（`recipes.ts` のコメント）。割り切りのままでよいなら 13・14 は落とすが、**「同じ機能を維持」と突き合わせると落ちている**ので挙げておく。

---

## 5. 進め方（T1 と T5 が入ってから）

1. **入力の規則と前提**（§2.3・§2.4）。本物の AI の前に、偽物のままで「上流の全部を読む」「理由の出る前提変更」を通す。帯に理由が出るところまで。
2. **`recipes` の表へ寄せる**（§1.2）。`ownerRecipes()` の差し替えと、設定の API の読み書きの付け替え。画面は変えない。
3. **お手本の文書と文書ガイドの抽出**（§3.3）。取り込み（ファイル・URL）→ 抽出 → 確かめて置き換え。
4. **設計の画面の続き**（並べ替え・段階の複製・重ならない名前・実行できない印）。
5. **本物の実行器**（T5）と繋ぎ、記事制作を最後まで通す。続きの扱い（§2.2 E）はここ。
6. 残り（手順ごとの固有名詞・snapshot と差分の確認）は §6 の答え次第。

## 6. オーナー・親セッションに相談したいこと

1. **手順を直したときの既存の録音**（§4 の 13・14）。旧アプリの「作成時の写しを固定し、明示的に更新する」を維持するか、editor の「次から効く」で割り切るか。維持するなら `step_runs` に手順の写しを持つ列が要る（表の変更 1 件）。
2. **前提（`input_basis`）の列を jsonb に広げる migration**（§2.4）。`0021`・`0022` は他のレーンが使うので番号を取っていない。番号をもらえれば T4 で書く。
3. **録音ごとの背景情報**（§2.2 G）。旧アプリは案件ごとに背景情報・登場人物・話者人数・言語を持ち、全段階の入力に入れていた。editor は持たない。表を足すか、v1 はアカウント共通の固有名詞だけにするか。
4. **手順ごとの固有名詞**（§3.3）。アカウント共通の `editor_settings.glossary` が既にある。手順ごとも持つか、共通だけにするか。
5. **参考ページ**（§2.2 H）。フォルダの木（T1）の後なら「同じフォルダの独立文書を自動で固定」を再現できる。v1 に入れるか。
6. **既定の手順で段階を並べ替えられるようにするか**（§3.3）。サブページ id は段階の index から決まるので、並べ替えると結び先が入れ替わる。許すなら「並べ替えると既にできているページの結び先が変わります」の確認が要る。許さないなら今のまま（複製してから）。
7. **途中までの出力を残すか**（§4 の 12）。v1 では入れない案。

