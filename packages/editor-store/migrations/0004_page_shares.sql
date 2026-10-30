BEGIN;

-- リンクで共有（#34・設計 §2 の `/s/{token}`・§5.3 の「…」）。読み取り専用・ログイン不要の共有リンクの鍵だけを持つ。
-- 共有中のページに 1 行。停止はこの行を消す（共有していない＝行が無い）。作り直しは token を入れ替え、rotated_at を入れる。
-- 本文はここに写さない。共有の読み取りは毎回 pages と join し、deleted_at IS NULL の最新の保存版を返す
-- （packages/editor-store/src/shares.ts）。

CREATE TABLE page_shares (
  page_id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 256 bit の乱数の base64url（43 文字）。リンクを何度も表示するので平文で持つ。形はこの CHECK に限る（他の値を入れられない）。
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- リンクを作り直した時刻（作り直していなければ null）
  rotated_at timestamptz,
  -- 共有の行は同じ owner のページにだけ付く。ページを消す（hard delete）と共有も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (rotated_at IS NULL OR rotated_at >= created_at)
);

-- ゴミ箱に入れたら共有を止める。戻しても同じリンクが静かに再び有効にならない（再び共有するかは、戻したあとに本人が決める）。
-- 削除の経路（store・SQL・今後のコード）によらず効くよう、保存のコードではなく DB のトリガーで行う。
CREATE FUNCTION stop_share_when_trashed()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM page_shares WHERE page_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER pages_stop_share_when_trashed
  AFTER UPDATE OF deleted_at ON pages
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION stop_share_when_trashed();

COMMIT;
