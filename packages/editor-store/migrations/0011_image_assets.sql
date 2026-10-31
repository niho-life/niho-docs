BEGIN;

-- 本文の画像（#33）。assets に、アップロードの状態と冪等キーを足す。
-- 画像の実体は private bucket の `image/{asset id}`（assets.bucket_path）。音声（0008）と同じ二段で、ブラウザが保存先へ直接
-- アップロードし、サーバーは「開始」と「完了」（bucket にある object の大きさが申告どおりか）だけを見る
-- （packages/editor-store/src/images.ts）。assets.sha256・content_type・bytes はクライアントの申告の値
-- （サーバーは中身を読まず、sha256 を検証しない）。
-- 読み取りはサーバーが中継する（`/api/assets/{id}`・共有は `/s/{token}/a/{id}`）。署名付き URL はブラウザへ渡さない。
-- 既存の行（音声の資産）は upload_status = 'ready' のまま（0008 の音声は page_recordings.audio_status が状態の正本）。

ALTER TABLE assets
  -- アップロードの状態。uploading は開始だけが済んだ行（中継も共有も返さない）
  ADD COLUMN upload_status text NOT NULL DEFAULT 'ready',
  -- 開始の要求の冪等キー（任意。同じ owner の中で 1 つ）
  ADD COLUMN upload_key uuid,
  -- 開始の要求の正規化した内容の SHA-256。同じキーで内容の違う要求を見分ける
  ADD COLUMN request_hash text;

ALTER TABLE assets
  ADD CONSTRAINT assets_upload_status_check
    CHECK (upload_status IN ('uploading', 'ready')),
  ADD CONSTRAINT assets_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  -- 冪等キーは owner ごとに 1 つ（NULL は重複してよい）
  ADD CONSTRAINT assets_upload_key_key
    UNIQUE (owner, upload_key);

-- 1 ページの画像の枚数（上限の検査）と、ページの画像の一覧。assets_page_idx（owner, page_id）に種類を足した形
CREATE INDEX assets_page_kind_idx ON assets (owner, page_id, kind);

COMMIT;
