BEGIN;

-- アカウントの設定（docs/architecture/editor-niho-life-design.md §6・§7.2、Issue #108）。owner ごとに 1 行。
-- 画面から変えられるのは、AI の提案の言語・固有名詞と誤りやすい表記・手順（段階の名前と指示とお手本）だけ。
-- 文字起こしのエンジンと保存先はここに持たない（エンジンはサーバーの設定、保存先は NIHO から毎回読む。設計 §2.1）。
-- 値の形と上限は packages/editor-store/src/settings.ts が決め、ここでは配列であることと件数だけを守る。
CREATE TABLE editor_settings (
  owner text PRIMARY KEY CHECK (length(owner) BETWEEN 1 AND 256),
  -- AI の提案の言語。same は「書いた言語のまま」
  ai_lang text NOT NULL DEFAULT 'same' CHECK (ai_lang IN ('same', 'ja', 'en')),
  -- 固有名詞と誤りやすい表記（[{ term, reading, variants, note }]）
  glossary jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(glossary) = 'array' AND jsonb_array_length(glossary) <= 200),
  -- 手順（[{ id, name, guide, steps: [{ id, name, instruction }] }]）。既定の手順に手を入れたものと、足したものだけが入る
  recipes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recipes) = 'array' AND jsonb_array_length(recipes) <= 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
