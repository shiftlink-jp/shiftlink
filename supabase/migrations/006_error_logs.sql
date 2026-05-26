-- ============================================================
-- エラーログテーブル
-- 本番で発生したJSエラー・未処理Promise rejectionを記録する
--
-- 既存PINアプリへの影響: ゼロ（新規テーブル追加のみ）
-- ============================================================

CREATE TABLE IF NOT EXISTS error_logs (
  id bigserial PRIMARY KEY,
  store_id uuid REFERENCES stores(id),
  -- 誰がエラーに遭遇したか（PINアプリのときはcast_id=0=オーナー）
  user_id integer,
  user_name text,
  is_owner boolean,
  -- エラー本体
  error_type text,
  error_message text,
  error_stack text,
  -- 発生コンテキスト
  url text,
  user_agent text,
  context text,    -- どの処理中に起きたか（手動セット）
  -- メタ情報
  created_at timestamptz DEFAULT now()
);

-- インデックス：日付・store_id・エラータイプ別に集計しやすく
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_store_id ON error_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_error_type ON error_logs(error_type);

-- 古いログの自動削除（30日経過したものは削除）
-- 手動で定期実行するか、pg_cron拡張で自動化する
COMMENT ON TABLE error_logs IS '本番JSエラーログ。30日以上経過したレコードは手動またはpg_cronで削除推奨';
