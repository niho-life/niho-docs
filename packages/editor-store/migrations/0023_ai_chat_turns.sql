BEGIN;

-- AI チャットが直接ページを書き換える形（旧 NIHO docs の「修正の会話」と同じ動き。Issue #38）。
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

COMMIT;
