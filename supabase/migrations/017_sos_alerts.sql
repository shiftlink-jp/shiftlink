-- ============================================================
-- 緊急SOSアラート
--
-- セラピストが本日ページの「緊急SOS」ボタンを押すと1行INSERTされる。
-- オーナーは本日ページで未対応(resolved=false)のSOSをバナー表示し、
-- 「対応済みにする」で resolved=true にする。
-- プッシュ通知OFFでも、店舗が本日ページを開けば気づけるようにするための保存先。
--
-- 既存PINアプリへの影響: ゼロ（新規テーブル追加のみ）。
-- PINアプリは store_id=NULL で書き込み・読み取りする（error_logs と同じ運用）。
-- ============================================================

CREATE TABLE IF NOT EXISTS sos_alerts (
  id bigserial PRIMARY KEY,
  store_id uuid REFERENCES stores(id),
  cast_id integer,
  cast_name text,
  message text,
  resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sos_alerts_created_at ON sos_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_alerts_store_id ON sos_alerts(store_id);
CREATE INDEX IF NOT EXISTS idx_sos_alerts_resolved ON sos_alerts(resolved);

-- PINアプリ（anon / pin-login authenticated）が読み書きできるよう権限付与。
-- RLSは有効化しない（error_logs と同じ運用。store_id フィルタはクライアント側で実施）。
GRANT SELECT, INSERT, UPDATE ON sos_alerts TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE sos_alerts_id_seq TO anon, authenticated;

COMMENT ON TABLE sos_alerts IS '緊急SOSアラート。オーナー本日ページで未対応をバナー表示する';
