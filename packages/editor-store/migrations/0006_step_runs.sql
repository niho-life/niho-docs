BEGIN;

-- 手順（#37）の実行の記録（docs/architecture/editor-steps-execution.md §5.1）。
-- 状態遷移はすべて packages/editor-store/src/step-runs.ts の条件つき UPDATE（世代と状態の CAS）で行う。
-- エラーは短い code だけを持ち、本文・プロンプト・鍵は持たない。

-- 段階の状態に「失敗」を足す（0001 の列の CHECK は自動の名前 pages_step_status_check）
ALTER TABLE pages DROP CONSTRAINT pages_step_status_check;
ALTER TABLE pages
  ADD CONSTRAINT pages_step_status_check
  CHECK (step_status IS NULL OR step_status IN ('done', 'run', 'wait', 'stale', 'failed'));

CREATE TABLE step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 親は同じ owner の録音ページ（kind の検査は作成の関数で行う）
  parent uuid NOT NULL,
  recipe text NOT NULL CHECK (length(recipe) BETWEEN 1 AND 256),
  from_step integer NOT NULL DEFAULT 0 CHECK (from_step >= 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  -- 同じ要求の再送で run を増やさないための値（任意。NULL は重複してよい）
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (owner, id),
  UNIQUE (owner, idempotency_key),
  -- ゴミ箱の purge（ページの物理削除）を止めない: 親のページが消えたら、その run も一緒に消える
  FOREIGN KEY (owner, parent) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at)
);

-- 帯に出す「最新の run」
CREATE INDEX step_runs_parent_idx ON step_runs (owner, parent, created_at DESC);

-- 同じ録音ページで進行中の run は 1 つだけ（読んでから作る race を DB で止める）
CREATE UNIQUE INDEX step_runs_active_idx
  ON step_runs (owner, parent)
  WHERE state IN ('queued', 'running');

CREATE TABLE step_attempts (
  run_id uuid NOT NULL REFERENCES step_runs (id) ON DELETE CASCADE,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step_id text NOT NULL CHECK (length(step_id) BETWEEN 1 AND 64),
  -- 出力のサブページ（id は親・recipe・段階から決定的に作る）。出力のサブページが物理削除されたら、その段階の記録も消える（purge を止めない）
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'reused')),
  -- claim のたびに 1 つ進む。確定・失敗・生存確認は世代が一致するときだけ通る（遅れた実行の結果で上書きしない）
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  tries integer NOT NULL DEFAULT 0 CHECK (tries >= 0),
  lease_until timestamptz,
  heartbeat_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  -- 実行したときの入力の基準（sha256 の 16 進）。前提変更の判定に使う
  input_basis text CHECK (input_basis IS NULL OR input_basis ~ '^[0-9a-f]{64}$'),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, step_index),
  CHECK (state <> 'running' OR lease_until IS NOT NULL)
);

-- 実行中の attempt は run あたり高々 1 つ
CREATE UNIQUE INDEX step_attempts_running_idx
  ON step_attempts (run_id)
  WHERE state = 'running';

-- 期限切れの lease の掃除
CREATE INDEX step_attempts_lease_idx
  ON step_attempts (state, lease_until)
  WHERE state = 'running';

COMMIT;
