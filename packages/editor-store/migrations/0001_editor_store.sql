BEGIN;

-- editor.niho.life のページの正本（docs/architecture/editor-niho-life-design.md §3）。
-- owner は NIHO の安定したユーザー ID だけを持つ。メール・名前・token の列は持たない。
-- 全ての読み書きは owner と deleted_at IS NULL で絞る（packages/editor-store/src/store.ts）。

CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'journal', 'rec', 'article', 'step')),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  lang text NOT NULL DEFAULT 'ja' CHECK (lang IN ('ja', 'en')),
  -- 本文の正本（ブロックの配列）。HTML は保存しない。ブロックの中身の厳密な検証は #33。
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks) = 'array'),
  cover uuid,
  lead text CHECK (lead IS NULL OR length(lead) <= 2000),
  parent uuid,
  recipe text CHECK (recipe IS NULL OR length(recipe) BETWEEN 1 AND 256),
  step_status text CHECK (step_status IS NULL OR step_status IN ('done', 'run', 'wait', 'stale')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE (owner, id),
  -- 親は同じ owner のページだけ（別の人のページの下には置けない）
  FOREIGN KEY (owner, parent) REFERENCES pages (owner, id) ON DELETE RESTRICT,
  CHECK (parent IS NULL OR parent <> id),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

-- サイドバーの一覧（更新順）
CREATE INDEX pages_owner_updated_idx
  ON pages (owner, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX pages_parent_idx
  ON pages (owner, parent)
  WHERE parent IS NOT NULL;

CREATE TABLE page_versions (
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  reason text NOT NULL CHECK (reason IN ('autosave', 'ai', 'publish')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, version)
);

-- 資産の実体は private bucket に置き、ここには object の位置と検証用の値だけを持つ（URL・署名は持たない）。
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  page_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'audio')),
  bucket_path text NOT NULL CHECK (
    length(bucket_path) BETWEEN 1 AND 1024
    AND bucket_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND bucket_path !~ '(^|/)\.\.(/|$)'
  ),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  alt text CHECK (alt IS NULL OR length(alt) <= 1000),
  credit text CHECK (credit IS NULL OR length(credit) <= 500),
  consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner, id),
  UNIQUE (bucket_path),
  -- 資産は同じ owner のページにだけ付く
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE
);

CREATE INDEX assets_page_idx ON assets (owner, page_id);

-- カバーは同じ owner の資産だけ
ALTER TABLE pages
  ADD CONSTRAINT pages_cover_owner_fkey
  FOREIGN KEY (owner, cover) REFERENCES assets (owner, id) ON DELETE RESTRICT;

CREATE TABLE publications (
  page_id uuid PRIMARY KEY REFERENCES pages (id) ON DELETE RESTRICT,
  dest text NOT NULL CHECK (length(dest) BETWEEN 1 AND 64),
  slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 160 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  range text NOT NULL CHECK (range IN ('live', 'unlisted')),
  published_version integer NOT NULL,
  category text CHECK (category IS NULL OR length(category) BETWEEN 1 AND 160),
  related jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(related) = 'array'),
  extras jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extras) = 'object'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  UNIQUE (dest, slug),
  FOREIGN KEY (page_id, published_version) REFERENCES page_versions (page_id, version) ON DELETE RESTRICT,
  CHECK (stopped_at IS NULL OR stopped_at >= published_at)
);

COMMIT;
