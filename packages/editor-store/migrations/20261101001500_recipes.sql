BEGIN;

-- 手順の実体（docs/architecture/editor-recipes-and-folders.md §2、Issue #37 の表）。
-- これまで手順は editor-web の TypeScript の定数（apps/editor-web/src/steps/recipes.ts の DEFAULT_RECIPES。docs-core の
-- FLOW_TEMPLATES の写し）と、手を入れた分だけを持つ editor_settings.recipes（0013）に分かれていた。
-- この表が実体になり、既定の 3 つ（記事制作・議事録・インサイト整理）も owner ごとの行として入る（origin = 'builtin'）。
-- 行が 1 つも無い owner の最初の読み出しで、既定（docs-core のテンプレート）と 0013 の列に保存されていた分を写して入れる
-- （apps/editor-web/src/server/recipe-source.ts）。editor_settings.recipes の列は、その引き継ぎが要らなくなる配備の
-- 1 つ後に落とす（expand → contract。列はこの migration では触らない）。
--
-- 名前は日時（#127 の new-migration。連番の取り合いを避ける）。適用は辞書順なので、既存の連番のあとに走る。
--
-- 値の形と上限は packages/editor-store/src/recipes.ts が 1 か所で決め、ここでは配列であることと件数だけを守る。
CREATE TABLE recipes (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 既定の `tpl-1`、足したものの `r-…`、取り込んだものの id のどれも通る形（settings の SETTINGS_ID_PATTERN と同じ）
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- お手本（文書ガイド。全段階の入力に入る Markdown）
  guide text NOT NULL DEFAULT '' CHECK (length(guide) <= 20000),
  -- 工程（[{ id, name, instruction, profile, provider? }]）。profile は AI の設定のプロファイル名（標準・高性能・軽量）
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 12),
  -- この手順の固有名詞と誤りやすい表記（[{ term, reading, variants, note }]）。アカウント共通の分は editor_settings.glossary
  terms jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(terms) = 'array' AND jsonb_array_length(terms) <= 200),
  -- お手本の文書（[{ id, name, chars, truncatedFrom?, sourceUrl? }]）。本文は資産として別に置く
  samples jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(samples) = 'array' AND jsonb_array_length(samples) <= 20),
  -- builtin＝既定の 3 つの写し（消せない）、own＝この人が足した、import＝旧 NIHO docs から取り込んだ（取り込みは未実装）
  origin text NOT NULL DEFAULT 'own' CHECK (origin IN ('builtin', 'own', 'import')),
  -- 一覧の並び（既定の 3 つ → 足したもの）。同じ値なら id の順
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  -- 保存のたびに 1 つ増える（録音の snapshot に写す値。docs-core の Flow.revision と同じ役）
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- 取り込みの受け皿（旧 NIHO docs の工程設計の id）。取り込みを入れるまでは NULL のまま（オーナー確認待ち）
  imported_from text CHECK (imported_from IS NULL OR length(imported_from) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, id),
  CHECK (updated_at >= created_at),
  -- 取り込んだ行だけが元の id を持つ
  CHECK (imported_from IS NULL OR origin = 'import')
);

-- 一覧（その人の手順を並びの順に）
CREATE INDEX recipes_owner_order_idx ON recipes (owner, sort_order, id);

COMMIT;
