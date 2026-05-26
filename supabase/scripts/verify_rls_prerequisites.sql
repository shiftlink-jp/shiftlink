-- ============================================================
-- RLS有効化前の事前確認スクリプト（本番DBで実行）
-- これは「読み取り専用」の確認SQLで、何も変更しない
-- ============================================================

-- 1. マイグレーション001で作られた基盤が存在するか
SELECT
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='stores') AS stores_exists,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='store_members') AS store_members_exists,
  EXISTS(SELECT 1 FROM pg_proc WHERE proname='get_my_store_id') AS get_my_store_id_exists,
  EXISTS(SELECT 1 FROM pg_proc WHERE proname='check_store_access') AS check_store_access_exists;

-- 2. store_idカラムが全テーブルに追加されているか
SELECT table_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=t.table_name AND column_name='store_id'
  ) THEN 'OK' ELSE '!!! MISSING !!!' END AS store_id_column
FROM (VALUES
  ('casts'),('shifts'),('reservations'),('customers'),('customer_visits'),
  ('works'),('courses'),('options'),('cast_fees'),('cast_discounts'),
  ('passkeys'),('push_subscriptions'),('store_settings'),('daily_notes'),
  ('monthly_sales'),('rooms')
) AS t(table_name);

-- 3. 現在のデータ状態：store_id IS NULL のレコード数（PINアプリのデータ）
SELECT 'casts' AS tbl, COUNT(*) FILTER (WHERE store_id IS NULL) AS null_rows, COUNT(*) FILTER (WHERE store_id IS NOT NULL) AS saas_rows FROM casts
UNION ALL SELECT 'shifts', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM shifts
UNION ALL SELECT 'reservations', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM reservations
UNION ALL SELECT 'customers', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM customers
UNION ALL SELECT 'works', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM works
UNION ALL SELECT 'courses', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM courses
UNION ALL SELECT 'options', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM options
UNION ALL SELECT 'rooms', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM rooms
UNION ALL SELECT 'push_subscriptions', COUNT(*) FILTER (WHERE store_id IS NULL), COUNT(*) FILTER (WHERE store_id IS NOT NULL) FROM push_subscriptions;

-- 4. 既存のRLSが有効になっているテーブル（あれば衝突の可能性あり）
SELECT schemaname, tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname='public' AND tablename IN (
  'casts','shifts','reservations','customers','customer_visits',
  'works','courses','options','cast_fees','cast_discounts',
  'passkeys','push_subscriptions','store_settings','daily_notes',
  'monthly_sales','rooms','stores','store_members'
)
ORDER BY tablename;

-- 5. 既存のポリシー一覧
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname='public'
ORDER BY tablename, policyname;
