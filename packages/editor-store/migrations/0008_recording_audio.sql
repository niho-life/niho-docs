BEGIN;

-- 録音の音声（#36 段 2a）。録音ページの page_recordings に、音声の資産（assets の行）への参照とアップロードの状態を足す。
-- 音声の実体は private bucket の `audio/{asset id}`（assets.bucket_path）。ブラウザが直接アップロードし、サーバーは
-- 「開始」と「完了」（bucket にある object の大きさが申告どおりか）だけを見る（packages/editor-store/src/recording-audio.ts）。
-- assets.sha256・content_type・bytes はクライアントの申告の値（サーバーは中身を読まず、sha256 を検証しない）。
-- 30 日で消すのは bucket のライフサイクル規則（prefix `audio/`）。アプリは期限（audio_expires_at）を持って画面に出すだけで、消さない。
-- 既存の行（VTT の録音）は audio_status = 'none' のまま（資産なし）。

ALTER TABLE page_recordings
  ADD COLUMN audio_asset uuid,
  ADD COLUMN audio_status text NOT NULL DEFAULT 'none',
  -- 音声の期限（作成の時刻 + 保持の日数）。表示のためだけに持つ
  ADD COLUMN audio_expires_at timestamptz,
  -- 開始の要求の冪等キー（任意。同じ owner の中で 1 つ）
  ADD COLUMN audio_upload_key uuid,
  -- 開始の要求の正規化した内容の SHA-256。同じキーで内容の違う要求を見分ける
  ADD COLUMN audio_request_hash text;

ALTER TABLE page_recordings
  ADD CONSTRAINT page_recordings_audio_status_check
    CHECK (audio_status IN ('none', 'uploading', 'uploaded')),
  ADD CONSTRAINT page_recordings_audio_request_hash_check
    CHECK (audio_request_hash IS NULL OR audio_request_hash ~ '^[0-9a-f]{64}$'),
  -- 音声が無い（none）ことと資産を指さないことは同じ
  ADD CONSTRAINT page_recordings_audio_asset_check
    CHECK ((audio_status = 'none') = (audio_asset IS NULL)),
  -- source = 'audio' でも audio_status = 'none' を許す（「音声のない音声由来の録音」）。音声は 30 日で bucket から消え、
  -- 複製したコピーは音声を持たないが、どちらも文字起こしは残るため。音声があるかどうかは audio_status と audio_asset だけで決める。
  -- 資産は同じ owner のものだけ。DEFERRABLE INITIALLY DEFERRED にする理由: ページを消す（hard delete・ゴミ箱の purge）と、
  -- assets と page_recordings はどちらもページの FK の CASCADE で同じ文の中で消え、資産の CASCADE が先に走る。即時の検査が
  -- それでも通るのは、PostgreSQL が CASCADE の中で積んだ検査を文の終わりに積んだ順で走らせるから（trigger の順序という内部の
  -- 実装に頼ることになる）。検査を commit の時まで遅らせ、同じ transaction の中なら資産と録音をどの順で消しても通るようにする。
  -- 録音が指している資産だけを消すことは、今まで通りできない（commit で断る）。
  ADD CONSTRAINT page_recordings_audio_asset_fkey
    FOREIGN KEY (owner, audio_asset) REFERENCES assets (owner, id) DEFERRABLE INITIALLY DEFERRED,
  -- 冪等キーは owner ごとに 1 つ（NULL は重複してよい）
  ADD CONSTRAINT page_recordings_audio_upload_key_key
    UNIQUE (owner, audio_upload_key);

COMMIT;
