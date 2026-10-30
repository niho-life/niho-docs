BEGIN;

-- ページ横断の検索（#35・設計 §4）。題名と本文の文字だけを 1 列に持ち、owner と deleted_at IS NULL で絞った上で
-- ILIKE の部分一致で探す（packages/editor-store/src/search.ts）。この列は検索の索引のためだけにあり、応答には出さない。

-- 部分一致（ILIKE '%語%'）を速くする trigram の索引に使う。
-- 置き場所は public に固定する（検索の対象の表が別の schema にあっても、その schema を消したときに一緒に消えないように）。
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- 題名 + 改行 + 本文の文字。本文は TipTap の doc の content（ブロックの配列）の text ノードの文字だけを拾い、
-- JSON の key・type の名前・属性の値は含めない。
-- 同じ親（段落・見出しなど）の中の text ノードは区切らずにつなぐ（太字・リンクで分かれた語も 1 語として当たる）。
-- 親が違えば改行で区切る。hardBreak は改行にする。順は文書の順（入れ子の位置の配列の辞書順）。
-- 本文は必ず「題名の文字数 + 2」文字目から始まる（題名が空でも、本文が空でも改行を 1 つ置く。search.ts がこれで本文を切り出す）。
-- 式の中で使う関数はどれも IMMUTABLE（jsonb_array_elements・string_agg・jsonb の演算子）。SQL 標準の本体（RETURN）は
-- 作るときに解析して依存を記録するので、実行時の search_path に左右されない（pg_restore でも同じ値になる）。
CREATE FUNCTION page_search_text(title text, blocks jsonb)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
RETURN coalesce(title, '') || E'\n' || coalesce((
  WITH RECURSIVE node (value, path) AS (
    SELECT e.value, ARRAY[e.ord]
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(blocks) = 'array' THEN blocks ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e (value, ord)
    UNION ALL
    SELECT c.value, n.path || c.ord
      FROM node AS n
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(n.value -> 'content') = 'array' THEN n.value -> 'content' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS c (value, ord)
  ),
  run (parent, body) AS (
    SELECT n.path[1:cardinality(n.path) - 1],
           string_agg(CASE WHEN n.value ->> 'type' = 'text' THEN n.value ->> 'text' ELSE E'\n' END, '' ORDER BY n.path)
      FROM node AS n
     WHERE (n.value ->> 'type' = 'text' AND jsonb_typeof(n.value -> 'text') = 'string')
        OR n.value ->> 'type' = 'hardBreak'
     GROUP BY 1
  )
  SELECT string_agg(run.body, E'\n' ORDER BY run.parent) FROM run
), '');

-- 保存のコード（store.ts）を変えずに、題名・本文が変わるたびに必ず最新になる（直接は書けない）。
-- 追加したときに既存の行にも値が入る（表を書き直す。trigger は発火しない）。
ALTER TABLE pages
  ADD COLUMN search_text text GENERATED ALWAYS AS (page_search_text(title, blocks)) STORED NOT NULL;

-- trigram の索引（ゴミ箱の行は含めない）。operator class は pg_trgm が入っている schema のものを名前で指す
-- （既に別の schema に入っている DB でも通るように、schema の名前は pg_extension から引く）。
DO $migration$
DECLARE
  trgm_schema name;
BEGIN
  SELECT n.nspname INTO STRICT trgm_schema
    FROM pg_extension AS e
    JOIN pg_namespace AS n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';
  EXECUTE format(
    'CREATE INDEX pages_search_text_trgm_idx ON pages USING gin (search_text %I.gin_trgm_ops) WHERE deleted_at IS NULL',
    trgm_schema
  );
END
$migration$;

COMMIT;
