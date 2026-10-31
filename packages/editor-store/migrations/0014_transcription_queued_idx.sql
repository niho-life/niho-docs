BEGIN;

-- 積み残された文字起こしの run を拾い直す掃除（#36 段 2b。apps/editor-web/src/server/transcription-worker-api.ts の sweep）が
-- 読む並び。0012 は running の取り残し（transcription_runs_running_idx）だけを索引にしていて、queued のまま残った run を
-- 古い順に読む経路が無かった。
CREATE INDEX transcription_runs_queued_idx
  ON transcription_runs (created_at)
  WHERE status = 'queued';

COMMIT;
