BEGIN;

-- 版と履歴・競合検知・ゴミ箱（docs/architecture/editor-niho-life-design.md §5.1・§12、Issue #33）。
-- 既にページと版が入っている DB に流しても、行はそのまま保つ（列の追加は既定値つき、CHECK は広げるだけ）。

-- 楽観ロックの番号。保存のたびに +1 し、保存の要求が持ってきた番号と違えば書かずに競合として返す。
ALTER TABLE pages
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

-- 版を残す理由に「この内容で上書き」の直前と「この版に戻す」の直前を足す。
ALTER TABLE page_versions
  DROP CONSTRAINT page_versions_reason_check;
ALTER TABLE page_versions
  ADD CONSTRAINT page_versions_reason_check
  CHECK (reason IN ('autosave', 'ai', 'publish', 'overwrite', 'restore'));

-- ゴミ箱の一覧（削除の新しい順）と、30 日を過ぎたものの完全削除
CREATE INDEX pages_owner_deleted_idx
  ON pages (owner, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

COMMIT;
