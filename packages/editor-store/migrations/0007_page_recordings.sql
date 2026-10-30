BEGIN;

-- 録音ページの文字起こし（#36 段 1・設計 §3 の recording・§7.1）。録音ページ（pages.kind = 'rec'）に 1 行。
-- 文字起こしは話者と時刻つきの段落（segments）と、話者番号から名前への表（speaker_names）だけを持つ。
-- 段落の形は docs-core の SpeechResultV1 の segments と同じ（{ start, end, text, speaker }。時刻は秒、話者は 1 始まりの番号か null）。
-- 名前は表に 1 つだけ持ち、表示は番号から名前を引く（名前を変えると全段落に反映される）。
-- 書き込みは revision を見て行う（別の画面で先に直されていたら上書きしない。packages/editor-store/src/recordings.ts）。
-- 音声の資産（assets）への参照は段 2 の migration で足す。原本の VTT・音声そのものはここに持たない（SHA-256 と名前だけ）。

CREATE TABLE page_recordings (
  page_id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 取り込んだ元（VTT のファイル・音声）
  source text NOT NULL CHECK (source IN ('vtt', 'audio')),
  language text NOT NULL CHECK (language IN ('ja', 'en')),
  -- 文字起こしをしたもの（VTT は 'vtt-import'）
  engine text CHECK (engine IS NULL OR length(engine) BETWEEN 1 AND 64),
  duration_sec numeric CHECK (duration_sec IS NULL OR duration_sec >= 0),
  -- 元のファイルの名前だけ（パス・制御文字を含まない）
  source_name text CHECK (
    source_name IS NULL
    OR (length(source_name) BETWEEN 1 AND 200 AND source_name !~ '[/\\]' AND source_name !~ '[[:cntrl:]]')
  ),
  -- 取り込んだ原本の SHA-256（サーバーで計算する。小文字 16 進 64 桁）
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  segments jsonb NOT NULL CHECK (jsonb_typeof(segments) = 'array'),
  speaker_names jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(speaker_names) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 録音は同じ owner のページにだけ付く。ページを消す（hard delete）と録音も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  -- 段落の数の上限（recordings.ts の RECORDING_SEGMENTS_MAX と同じ）。配列でない値は上の CHECK が断る
  CONSTRAINT page_recordings_segments_max CHECK (
    CASE WHEN jsonb_typeof(segments) = 'array' THEN jsonb_array_length(segments) <= 20000 ELSE false END
  ),
  CHECK (updated_at >= created_at)
);

COMMIT;
