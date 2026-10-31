BEGIN;

-- プレビュー（#40）の著者を token に結ぶ。公開 API の要求には本人の session が無いので、発行のときの本人の著者
-- （契約の Author: 名前・handle・url）を token の行に置き、プレビューはそれで組む。公開と同じく、名前が無ければ著者なし。
-- 著者の無い token（この migration より前に発行したもの・名前の無い本人のもの）は、いまの公開版の著者で組む（無ければ 404）。
-- 既存の行は消さず、著者なし（NULL）のまま残す。token は 15 分で切れるので、移す値は要らない。
ALTER TABLE preview_tokens
  ADD COLUMN author_name text CHECK (author_name IS NULL OR (btrim(author_name) <> '' AND length(author_name) <= 256)),
  ADD COLUMN author_handle text CHECK (author_handle IS NULL OR (btrim(author_handle) <> '' AND length(author_handle) <= 256)),
  ADD COLUMN author_url text CHECK (author_url IS NULL OR (author_url ~ '^https://[^/?#@[:space:]]+' AND length(author_url) <= 2048)),
  -- 名前の無い著者は無い（handle・url だけは置かない）
  ADD CONSTRAINT preview_tokens_author_check CHECK (author_name IS NOT NULL OR (author_handle IS NULL AND author_url IS NULL));

COMMIT;
