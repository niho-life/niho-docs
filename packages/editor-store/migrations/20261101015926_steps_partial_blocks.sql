BEGIN;

-- 段階が「続きを使い切っても書き切れなかった」で終わったときの、書けたところまでの本文（#37。
-- 設計 docs/architecture/editor-steps-recipes.md §2.5）。旧 NIHO docs の RunCheckpoint の output に当たる。
-- 長い文字起こし修正はここに当たる段階なので、捨てると十数分かけた本文が丸ごと消える。
-- サブページの本文には書かない（失敗した段階のページを半分の本文で埋めない）。帯から読むためだけに持つ。
ALTER TABLE step_attempts
  ADD COLUMN partial_blocks jsonb
    CHECK (partial_blocks IS NULL OR jsonb_typeof(partial_blocks) = 'array');

COMMIT;
