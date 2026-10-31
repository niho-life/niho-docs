BEGIN;

-- 公開（#39 公開のシート・#40 公開 API・#41 発信先の設定）の正本。docs/architecture/editor-publish-core.md・
-- docs/security/editor-publish-api-v1.md。意味の正本は packages/editor-publish のポート（PublishTx・ConnectionTx）と
-- そのメモリの実装（test-support/memory-store.ts）で、ここはそれを制約で守る。読み書きは packages/editor-store/src/publications.ts。
-- 鍵とプレビューの token は平文を持たない（SHA-256 の 16 進だけ）。

-- 0001 の publications はどこからも書かれていない（page_versions の版を指す形で、不変の公開版を持てない）ので作り直す。
-- 行があれば作り直しで消えてしまうので、migration ごと止める（移す方法は無い。中身を確かめてから手で片付ける）。
LOCK TABLE publications IN ACCESS EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM publications) THEN
    RAISE EXCEPTION 'editor-store 0009: publications has rows; refusing to recreate the table';
  END IF;
END
$migration$;
DROP TABLE publications;

-- 読み取り先の handle が出す発信先（契約の destOfHandle と同じ）。面は予約語 exp / niho、本人のサイトは接続の handle
-- （3〜32 文字の英小文字・数字・ハイフンで、予約語を除く）。それ以外は null。
CREATE FUNCTION publish_dest_of_handle(handle text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
RETURN CASE
  WHEN handle IN ('exp', 'niho') THEN handle
  WHEN handle ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'
   AND handle NOT IN ('exp', 'niho', 'preview', 'v1', 'api', 'admin', 'editor') THEN 'site'
END;

-- 公開版: 公開・更新・設定の保存のたびに 1 つ足す、不変のスナップショット（契約の PublishedDoc ＋ range・fingerprint）。
-- 番号はページごとの連番で、発信先を移っても続く。書き換えと削除は trigger で断る
-- （ページそのものを完全に消すときの連鎖だけは通す。公開の行があるページは publications の FK が消させない）。
CREATE TABLE publication_versions (
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  -- この版を出した読み取り先（面は exp / niho、本人のサイトは接続の handle）
  handle text NOT NULL CHECK (publish_dest_of_handle(handle) IS NOT NULL),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, version),
  -- publications はこの組で版を指す（公開はいつも自分の handle の版を指す）
  UNIQUE (page_id, version, handle),
  -- スナップショットはこの行のページ・版・発信先のもの（CHECK は null を通すので、無い値も違う値として断る）
  CHECK (snapshot ->> 'id' IS NOT DISTINCT FROM page_id::text),
  CHECK (snapshot -> 'version' IS NOT DISTINCT FROM to_jsonb(version)),
  CHECK (snapshot ->> 'dest' IS NOT DISTINCT FROM publish_dest_of_handle(handle))
);

CREATE FUNCTION publication_versions_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- ページの行がもう無い削除は、ページの完全削除（ON DELETE CASCADE）の連鎖
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'publication_versions are immutable' USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER publication_versions_immutable
  BEFORE UPDATE OR DELETE ON publication_versions
  FOR EACH ROW
  EXECUTE FUNCTION publication_versions_immutable();

-- 公開: ページごとに 1 行。いま出している版（version）と、シートで選んだ設定を持つ。
-- 公開をやめても行は残し（stopped_at）、その handle の slug を押さえ続ける（再公開は同じ URL）。
-- 時刻は PublishService の時計の値（published_at は初回の公開、updated_at はいまの版を出した時刻）。
CREATE TABLE publications (
  page_id uuid PRIMARY KEY REFERENCES pages (id) ON DELETE RESTRICT,
  dest text NOT NULL CHECK (dest IN ('exp', 'niho', 'site')),
  handle text NOT NULL,
  slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 160 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  range text NOT NULL CHECK (range IN ('live', 'unlisted')),
  -- 「あわせて」
  extras_app boolean NOT NULL,
  extras_news boolean NOT NULL,
  extras_xp boolean NOT NULL,
  category text CHECK (category IS NULL OR length(category) BETWEEN 1 AND 160),
  -- 関連する体験の slug（申告。発信先の面が受け取るときに確かめ直す）
  related text[] NOT NULL DEFAULT '{}' CHECK (cardinality(related) <= 20 AND array_position(related, NULL) IS NULL),
  version integer NOT NULL,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  stopped_at timestamptz,
  -- 同じ読み取り先の同じ URL は 1 ページだけ（公開をやめたものも含む）
  UNIQUE (handle, slug),
  FOREIGN KEY (page_id, version, handle) REFERENCES publication_versions (page_id, version, handle) ON DELETE RESTRICT,
  CHECK (publish_dest_of_handle(handle) IS NOT DISTINCT FROM dest),
  -- 限定公開は NIHO の面だけ
  CHECK (dest <> 'site' OR range = 'live')
);

-- 公開 API の一覧（その handle の公開中を、更新の新しい順。同じ時刻はページ id の昇順）
CREATE INDEX publications_live_idx
  ON publications (handle, updated_at DESC, page_id)
  WHERE stopped_at IS NULL;

-- NIHO の面の旧 URL の転送（公開をやめた URL → 一覧、面から面へ移した URL → 新しい URL）。from ごとに 1 行。
-- 鎖は 1 段に保つ（PublishService が付け替える）。行は from の slug を、そこを離れたページ（page_id）のために押さえる。
-- 本人のサイトは転送を約束しないので、from も to も面だけ。
CREATE TABLE publication_redirects (
  from_handle text NOT NULL CHECK (from_handle IN ('exp', 'niho')),
  from_slug text NOT NULL CHECK (length(from_slug) BETWEEN 1 AND 160 AND from_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- 行き先の場所。どちらも null なら一覧
  to_handle text CHECK (to_handle IS NULL OR to_handle IN ('exp', 'niho')),
  to_slug text CHECK (to_slug IS NULL OR (length(to_slug) BETWEEN 1 AND 160 AND to_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')),
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (from_handle, from_slug),
  CHECK ((to_handle IS NULL) = (to_slug IS NULL)),
  CHECK (to_handle IS NULL OR (to_handle, to_slug) IS DISTINCT FROM (from_handle, from_slug))
);

CREATE INDEX publication_redirects_to_idx
  ON publication_redirects (to_handle, to_slug)
  WHERE to_handle IS NOT NULL;

CREATE INDEX publication_redirects_page_idx ON publication_redirects (page_id);

-- 本人のサイトの接続（#41）。handle は作ったあと変えられず、解除したあとも他の接続に渡さない（行は消さない）。
CREATE TABLE site_connections (
  id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  handle text NOT NULL UNIQUE CHECK (publish_dest_of_handle(handle) IS NOT DISTINCT FROM 'site'),
  mode text NOT NULL CHECK (mode IN ('api', 'wordpress', 'ghost')),
  site_url text NOT NULL CHECK (length(site_url) <= 2048 AND site_url ~ '^https://[^[:space:]?#]+$'),
  -- 記事の URL の形 https://{url_host}/{url_path}/{slug}（url_path が空なら https://{url_host}/{slug}）
  url_host text NOT NULL CHECK (
    length(url_host) <= 253
    AND url_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  url_path text NOT NULL CHECK (length(url_path) <= 64 AND url_path ~ '^[a-z0-9-]*$'),
  -- 写真の扱い（取り込むときに複製する。v1 は固定）
  asset_policy text NOT NULL CHECK (asset_policy = 'copy-on-import'),
  -- WordPress・Ghost への送信は v1 では動かさない
  push_enabled boolean NOT NULL DEFAULT false CHECK (NOT push_enabled),
  created_at timestamptz NOT NULL,
  removed_at timestamptz
);

CREATE INDEX site_connections_owner_idx ON site_connections (owner, created_at);

-- 接続の鍵。平文は持たない（SHA-256 の 16 進と、表示に使う末尾 4 文字だけ）。
CREATE TABLE site_connection_keys (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES site_connections (id) ON DELETE RESTRICT,
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  last4 text NOT NULL CHECK (last4 ~ '^[A-Za-z0-9_-]{4}$'),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX site_connection_keys_connection_idx ON site_connection_keys (connection_id);

-- 接続は消さず、決まった値（id・owner・handle・作成時刻）を変えず、解除を取り消さない。
-- 鍵は決まった値（id・接続・ハッシュ・末尾・作成時刻）を変えず、失効を取り消さない。
CREATE FUNCTION site_connections_guard()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'site_connections rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner OR NEW.handle IS DISTINCT FROM OLD.handle
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL) THEN
    RAISE EXCEPTION 'site_connections: fixed values cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER site_connections_guard
  BEFORE UPDATE OR DELETE ON site_connections
  FOR EACH ROW
  EXECUTE FUNCTION site_connections_guard();

CREATE FUNCTION site_connection_keys_guard()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.last4 IS DISTINCT FROM OLD.last4
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'site_connection_keys: fixed values cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER site_connection_keys_guard
  BEFORE UPDATE ON site_connection_keys
  FOR EACH ROW
  EXECUTE FUNCTION site_connection_keys_guard();

-- プレビューの token（#40）。平文は持たない（SHA-256 の 16 進）。本人が発行し、1 つのページと 1 つの読み取り先
-- （本人のサイトは接続の handle）に拘束する。下書きの版には拘束しない。発行から 15 分以内で切れる。
CREATE TABLE preview_tokens (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_id uuid NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  handle text NOT NULL CHECK (publish_dest_of_handle(handle) IS NOT NULL),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- 同じ owner のページにだけ付く。ページを消す（hard delete）と token も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at AND expires_at - issued_at <= interval '15 minutes')
);

-- 期限切れの掃除
CREATE INDEX preview_tokens_expires_idx ON preview_tokens (expires_at);

COMMIT;
