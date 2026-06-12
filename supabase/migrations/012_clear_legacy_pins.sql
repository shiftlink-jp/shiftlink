-- ============================================================
-- ShiftLink 平文PINクリア（#1 権限昇格対策の最終段）
--
-- 011_secure_pins.sql で auth_pins へハッシュ移行済みの前提で、
-- casts.pin / store_settings.owner_pin の「平文」を NULL クリアする。
-- これでキャストが casts / store_settings を SELECT しても PIN は得られない。
--
-- ★必ず 011 の後、かつ以下が本番反映されてから実行すること★
--   1) pin-login 新版（auth_pins 照合＋平文フォールバック）デプロイ済み
--   2) set-pin Edge Function デプロイ済み
--   3) index.html 新版（PIN設定/変更が set-pin 経由）デプロイ済み
--   これらより先に実行すると、平文に依存する旧ログイン/旧PIN変更が壊れる。
--   （pin-login 新版は auth_pins を優先するため、本クリア後も継続動作する）
--
-- 列は DROP しない（旧コードや他参照が列の存在を前提にしている可能性を考慮）。
-- NULL 化のみ。冪等。
-- ============================================================

UPDATE casts          SET pin = NULL       WHERE pin IS NOT NULL;
UPDATE store_settings SET owner_pin = NULL WHERE owner_pin IS NOT NULL;

-- 確認:
--   SELECT count(*) FROM casts WHERE pin IS NOT NULL;            -- → 0
--   SELECT count(*) FROM store_settings WHERE owner_pin IS NOT NULL; -- → 0
-- ============================================================
