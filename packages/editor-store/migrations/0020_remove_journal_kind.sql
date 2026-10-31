BEGIN;

-- 番号が 0020 なのは、並行する PR（公開の保存・公開 API）が 0009 以降を使うため（番号は一意であればよく、順序に依存しない）。
-- 日記（pages.kind = 'journal'）をやめた（オーナー判断 2026-10-31）。既存の journal の行は note にする。題名・本文・版・時刻は変えない。
-- kind の CHECK は 0001 が名前を付けずに作ったので、PostgreSQL の既定の名前（pages_kind_check）で付け替える。

ALTER TABLE pages DROP CONSTRAINT pages_kind_check;

UPDATE pages SET kind = 'note' WHERE kind = 'journal';

ALTER TABLE pages
  ADD CONSTRAINT pages_kind_check CHECK (kind IN ('note', 'rec', 'article', 'step'));

COMMIT;
