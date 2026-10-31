BEGIN;

-- AI チャット（会話）の保存（docs/architecture/editor-niho-life-design.md §6、Issue #38）。
-- 旧アプリ（packages/docs-core の conversation.ts）はファイルに会話を持っていたが、editor は正本をサーバーに 1 つ置く。
--
-- - 会話はページに紐づく（ページが消えれば会話も消える）。発言は会話の中で 1 から順の seq を持つ。
-- - 人の発言（role = 'user'）は頼んだこと（preset の名前か、自由入力の「直したいこと」）。
-- - AI の発言（role = 'assistant'）は結果の一言と、そのときの提案（proposal）。提案はページを変えない。
-- - 採用したものだけが版になる。採用した発言に、採用した中身（adopted）と残った版の番号（version）を書く。
--   版は page_versions の掃除で消えるので FK は張らず、番号だけを持つ（履歴から辿るための手がかり）。
-- - 鍵・プロンプト・モデルへ送った文そのものは持たない（持つのは頼んだことと提案の中身だけ）。
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  page_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- owner と id の組で引く（他人の会話は「無い」と同じ）
  UNIQUE (owner, id),
  -- ゴミ箱の purge（ページの物理削除）を止めない: ページが消えたら、その会話も一緒に消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at)
);

-- ページの会話の一覧（新しい順）
CREATE INDEX ai_conversations_page_idx ON ai_conversations (owner, page_id, updated_at DESC);

CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- 画面に出す文（人の発言は頼んだこと、AI の発言は結果の一言）。本文そのものは入れない
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  -- 候補から頼んだときの preset の id（自由入力は NULL）
  preset text CHECK (preset IS NULL OR preset ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'),
  -- そのときの提案（{ label, baseRevision, changes, inserts, unchanged }）。大きさは editor-store が見る
  proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  -- 採用した中身（{ changes, inserts }）と、採用の前の本文が残った版の番号
  adopted jsonb CHECK (adopted IS NULL OR jsonb_typeof(adopted) = 'object'),
  version integer CHECK (version IS NULL OR version >= 1),
  adopted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 会話の中で発言の順は 1 つずつ
  UNIQUE (conversation_id, seq),
  -- 人の発言は提案も採用も持たない
  CHECK (role <> 'user' OR (proposal IS NULL AND adopted IS NULL AND version IS NULL AND adopted_at IS NULL)),
  -- AI の発言は preset を持たない
  CHECK (role <> 'assistant' OR preset IS NULL),
  -- 採用は「中身・版・時刻」がそろうか、3 つとも無いか
  CHECK ((adopted IS NULL AND version IS NULL AND adopted_at IS NULL) OR (adopted IS NOT NULL AND version IS NOT NULL AND adopted_at IS NOT NULL)),
  -- 採用があるなら、その元の提案がある
  CHECK (adopted IS NULL OR proposal IS NOT NULL)
);

-- 会話を開いたときに読む順
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, seq);

COMMIT;
