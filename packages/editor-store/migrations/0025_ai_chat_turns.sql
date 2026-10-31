BEGIN;

-- AI チャットが直接ページを書き換える形（旧 NIHO docs の「修正の会話」と同じ動き。Issue #38）と、
-- 旧アプリで AI の入力になっていたもの（「あなたについて」）、実行経路（サーバーの API / この Mac の CLI）。
-- 0022 の会話に、1 回の依頼（turn）の作業の要約と結果、そのとき直した・作ったページを足す。
--
-- - 提案（proposal）は採用されるまでページを変えないが、チャットは依頼の中でページを書き換える。
--   書く前の本文は必ず版（reason = 'ai'）に残り、その版の番号を ai_message_changes に持つ（人が「元に戻す」で戻せる）。
-- - 残すのは作業の要約（道具の名前・ページの名前・成否）と返答だけ。本文・プロンプト・鍵は残さない。

ALTER TABLE ai_messages
  -- 作業の要約（[{ kind: "narration" | "tool", … }]）。AI の発言だけが持つ
  ADD COLUMN items jsonb CHECK (items IS NULL OR jsonb_typeof(items) = 'array'),
  -- 依頼の結果。done は終わった、failed は AI の失敗、stopped は上限・中断で途中まで
  ADD COLUMN result text CHECK (result IS NULL OR result IN ('done', 'failed', 'stopped')),
  -- 止まった理由の短い code（本文・内部の情報は入れない）
  ADD COLUMN result_code text CHECK (result_code IS NULL OR result_code ~ '^[a-z0-9_]{1,64}$');

ALTER TABLE ai_messages
  -- 人の発言は作業も結果も持たない
  ADD CONSTRAINT ai_messages_user_has_no_work
  CHECK (role <> 'user' OR (items IS NULL AND result IS NULL AND result_code IS NULL));

-- 1 回の依頼で直した・作ったページ（旧アプリの TurnPageChange）。
CREATE TABLE ai_message_changes (
  message_id uuid NOT NULL REFERENCES ai_messages (id) ON DELETE CASCADE,
  -- ページが物理削除されたら、その記録も消える（ゴミ箱の purge を止めない）
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  change text NOT NULL CHECK (change IN ('edited', 'created')),
  -- 直す前の本文が残った版の番号（「元に戻す」で戻す先）。作ったページは持たない
  version integer CHECK (version IS NULL OR version >= 1),
  -- 依頼が書き終えたときの revision。これと違えば人があとから直しているので、「元に戻す」で上書きしない
  revision integer NOT NULL CHECK (revision >= 1),
  -- 依頼のあとの字数と、依頼の前からの増減
  chars integer NOT NULL CHECK (chars >= 0),
  delta integer NOT NULL,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 同じ依頼で同じページを何度書いても 1 行（版は最初の 1 つ＝依頼の前の本文）
  PRIMARY KEY (message_id, page_id),
  CHECK (change <> 'edited' OR version IS NOT NULL)
);

-- ページから、そのページを変えた依頼を引く
CREATE INDEX ai_message_changes_page_idx ON ai_message_changes (page_id, created_at DESC);

-- 誰が文を作ったか（設計 §6）。route は サーバーの API（server）か、この Mac の CLI（device。利用者のサブスク）。
-- engine は短い id（`anthropic:claude-sonnet-5-5`・`cli:claude-code`）だけで、鍵・端末の情報は持たない。
ALTER TABLE ai_messages
  ADD COLUMN route text CHECK (route IS NULL OR route IN ('server', 'device')),
  ADD COLUMN engine text CHECK (engine IS NULL OR engine ~ '^[a-z0-9][a-z0-9._:-]{0,95}$');

ALTER TABLE ai_messages
  -- 人の発言は経路を持たない（作ったのは人）
  ADD CONSTRAINT ai_messages_user_has_no_route CHECK (role <> 'user' OR (route IS NULL AND engine IS NULL));

-- この Mac の CLI（利用者のサブスク）の使用量。owner ごと・月ごとに 1 行で、**金額は持たない**
-- （従量が出ないので数えない。月の上限（USD）で止めるのは ai_usage ＝サーバーの API の経路だけ）。
--
-- **ai_usage には触らない。** 主キーを (owner, month, source) に貼り替えると、配備の最中にまだ動いている
-- 古い revision の `INSERT … ON CONFLICT (owner, month)` が
-- 「there is no unique or exclusion constraint matching the ON CONFLICT specification」で落ちる
-- （migration はサービスの入れ替えより先に走る）。経路を列で分けず、表を分けるのはこのため。
CREATE TABLE ai_usage_device (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, month)
);

-- 「あなたについて」（旧アプリの about.json）。プロンプトに入れる本人の説明と書き方の希望で、
-- **公開のときの著者情報とは別物**（公開は publications 側が持つ）。
ALTER TABLE editor_settings
  ADD COLUMN about text NOT NULL DEFAULT '' CHECK (length(about) <= 2000);

COMMIT;
