BEGIN;

-- AI の使用量（docs/architecture/editor-niho-life-design.md §6、Issue #38）。owner ごと・月ごとに 1 行。
-- 月は Asia/Tokyo の年月（YYYY-MM）。加算は INSERT … ON CONFLICT DO UPDATE で原子的に行う（packages/editor-store/src/ai-usage.ts）。
-- 金額は見込み（返ったトークン数 × アプリ内の単価表）を micro-USD の整数で持つ。請求の正は各社の管理画面。
CREATE TABLE ai_usage (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, month)
);

COMMIT;
