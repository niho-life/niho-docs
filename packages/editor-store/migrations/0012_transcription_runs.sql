BEGIN;

-- 録音の文字起こしの実行（#36 段 2b）。アップロード済みの録音の音声（0008）を、サーバー側のエンジン（Deepgram・開発の偽物）で
-- 文字起こしして page_recordings の segments に書く。1 回の実行（「もう一度」を含む）が 1 行。
-- 状態遷移は packages/editor-store/src/transcription-runs.ts の条件つき UPDATE（世代と状態の CAS）で行う。
-- 手順（#37）の実行の表（0006）とは別の経路（docs/architecture/editor-steps-execution.md §5.6）。
-- 本文（文字起こしの結果）・音声・エンジンの応答・鍵は持たない。失敗は短い code だけ。
-- terms は要求の固有名詞の表記（Deepgram の keyterm に渡す。実行する側が読むため run に持つ）。

CREATE TABLE transcription_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  engine text NOT NULL CHECK (engine IN ('deepgram', 'fake')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  language text NOT NULL CHECK (language IN ('ja', 'en')),
  diarize boolean NOT NULL DEFAULT true,
  -- 既にある段落を置き換えてよいか（false なら、段落が空の録音にだけ書く）
  replace boolean NOT NULL DEFAULT false,
  -- 固有名詞の表記の配列（100 個まで）
  terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- claim のたびに 1 つ進む。確定・失敗は世代が一致するときだけ通る（古い実行が後から確定するのを防ぐ）
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  error_code text CHECK (
    error_code IS NULL
    OR error_code IN (
      'audio_missing', 'audio_expired', 'engine_unavailable', 'engine_rejected', 'engine_timeout', 'engine_bad_response', 'too_large', 'internal'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  -- run は同じ owner のページにだけ付く。ページを消す（hard delete・ゴミ箱の purge）と run も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CONSTRAINT transcription_runs_terms_check CHECK (
    CASE WHEN jsonb_typeof(terms) = 'array' THEN jsonb_array_length(terms) <= 100 ELSE false END
  ),
  -- 失敗の code は失敗のときだけ（失敗には必ず code がある）
  CONSTRAINT transcription_runs_error_check CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  -- 時刻と状態の整合: queued は開始も終了もなし、running は開始あり・終了なし、succeeded は両方、
  -- failed は終了あり（claim の前に失敗したもの（積めなかった・掃除）は開始なし）
  CONSTRAINT transcription_runs_status_times_check CHECK (
    CASE status
      WHEN 'queued' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'succeeded' THEN started_at IS NOT NULL AND finished_at IS NOT NULL
      ELSE finished_at IS NOT NULL
    END
  ),
  CONSTRAINT transcription_runs_order_check CHECK (
    (started_at IS NULL OR started_at >= created_at)
    AND (finished_at IS NULL OR finished_at >= created_at)
    AND (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
  )
);

-- 録音ページの最新の run
CREATE INDEX transcription_runs_page_idx ON transcription_runs (owner, page_id, created_at DESC);

-- 1 つのページで有効な run（queued・running）は 1 つだけ（読んでから作る race を DB で止める）
CREATE UNIQUE INDEX transcription_runs_active_idx
  ON transcription_runs (page_id)
  WHERE status IN ('queued', 'running');

-- 実行中のまま古くなった run の掃除
CREATE INDEX transcription_runs_running_idx
  ON transcription_runs (started_at)
  WHERE status = 'running';

COMMIT;
