-- 指名の完全動的化（追加・名前変更対応）
-- store_settings.shimei_list: 指名タイプ一覧 JSON
--   [{ "key":"free|net|hon|c<timestamp>", "name":"表示名", "sale":店舗料金 }]
--   key=free/net/hon は既存3種（レガシー列 shimei_free/net/hon と同期）。
--   それ以外は店舗が追加したカスタム指名。
--   NULL のときはレガシー3種にフォールバックするため、既存店舗の挙動は不変。
-- cast_fees.extra_shimei_backs: カスタム指名のキャスト別バック JSON
--   { "shimei_<key>": 金額 }（既存3種は従来どおり shimei_free/net/hon 列を使用）
ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS shimei_list jsonb;

ALTER TABLE cast_fees
  ADD COLUMN IF NOT EXISTS extra_shimei_backs jsonb DEFAULT '{}'::jsonb;
