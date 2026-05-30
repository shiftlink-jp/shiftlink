-- ============================================================
-- 古い（allow_all_* 等）RLSポリシーを削除し、rls_* ポリシーを有効化する
--
-- 背景:
--   005_rls_store_isolation.sql でrls_*ポリシーを定義・RLSを有効化済みだが、
--   以前から存在する allow_all_* / read * / insert * 等の古いポリシーが
--   OR条件で rls_* ポリシーを無効化していた。
--   このマイグレーションで古いポリシーを削除し、rls_*ポリシーのみに一本化する。
--
-- 影響範囲:
--   - KYOUKANOアプリ(store_id=NULL): 引き続きanon鍵でアクセス可（check_store_access設計通り）
--   - SaaSユーザー: 自店舗のstore_idデータのみアクセス可
--   - Edge Functions: service_role鍵を使用のためRLSをバイパス（影響なし）
--   - customer_memos: shop_idカラムのため対象外（既存ポリシーを維持）
-- ============================================================

-- casts
DROP POLICY IF EXISTS "allow_all_casts" ON casts;
DROP POLICY IF EXISTS "delete casts" ON casts;
DROP POLICY IF EXISTS "delete casts2" ON casts;
DROP POLICY IF EXISTS "insert casts" ON casts;
DROP POLICY IF EXISTS "read casts" ON casts;
DROP POLICY IF EXISTS "read casts for join" ON casts;
DROP POLICY IF EXISTS "update casts" ON casts;

-- shifts
DROP POLICY IF EXISTS "allow_all_shifts" ON shifts;
DROP POLICY IF EXISTS "delete shifts" ON shifts;
DROP POLICY IF EXISTS "insert shifts" ON shifts;
DROP POLICY IF EXISTS "read shifts" ON shifts;
DROP POLICY IF EXISTS "update shifts" ON shifts;

-- reservations
DROP POLICY IF EXISTS "allow_all_reservations" ON reservations;
DROP POLICY IF EXISTS "delete reservations" ON reservations;
DROP POLICY IF EXISTS "insert reservations" ON reservations;
DROP POLICY IF EXISTS "read reservations" ON reservations;
DROP POLICY IF EXISTS "update reservations" ON reservations;

-- customers
DROP POLICY IF EXISTS "allow_all_customers" ON customers;
DROP POLICY IF EXISTS "delete customers" ON customers;
DROP POLICY IF EXISTS "insert customers" ON customers;
DROP POLICY IF EXISTS "read customers" ON customers;
DROP POLICY IF EXISTS "update customers" ON customers;

-- customer_visits
DROP POLICY IF EXISTS "allow_all_customer_visits" ON customer_visits;
DROP POLICY IF EXISTS "delete visits" ON customer_visits;
DROP POLICY IF EXISTS "insert visits" ON customer_visits;
DROP POLICY IF EXISTS "read visits" ON customer_visits;
DROP POLICY IF EXISTS "update visits" ON customer_visits;

-- works
DROP POLICY IF EXISTS "allow_all_works" ON works;
DROP POLICY IF EXISTS "delete works" ON works;
DROP POLICY IF EXISTS "delete works2" ON works;
DROP POLICY IF EXISTS "insert works" ON works;
DROP POLICY IF EXISTS "read works" ON works;
DROP POLICY IF EXISTS "update works" ON works;

-- courses
DROP POLICY IF EXISTS "anyone can read courses" ON courses;
DROP POLICY IF EXISTS "read courses" ON courses;
DROP POLICY IF EXISTS "service_role can write courses" ON courses;

-- options
DROP POLICY IF EXISTS "anyone can read options" ON options;
DROP POLICY IF EXISTS "read options" ON options;
DROP POLICY IF EXISTS "service_role can write options" ON options;

-- cast_fees
DROP POLICY IF EXISTS "allow_all_cast_fees" ON cast_fees;
DROP POLICY IF EXISTS "insert cast_fees" ON cast_fees;
DROP POLICY IF EXISTS "read cast_fees" ON cast_fees;
DROP POLICY IF EXISTS "update cast_fees" ON cast_fees;

-- cast_discounts
DROP POLICY IF EXISTS "allow_all_cast_discounts" ON cast_discounts;
DROP POLICY IF EXISTS "delete cast_discounts" ON cast_discounts;
DROP POLICY IF EXISTS "insert cast_discounts" ON cast_discounts;
DROP POLICY IF EXISTS "read cast_discounts" ON cast_discounts;
DROP POLICY IF EXISTS "update cast_discounts" ON cast_discounts;

-- passkeys
DROP POLICY IF EXISTS "allow all" ON passkeys;

-- push_subscriptions
DROP POLICY IF EXISTS "delete_own" ON push_subscriptions;
DROP POLICY IF EXISTS "insert_own" ON push_subscriptions;
DROP POLICY IF EXISTS "select_own" ON push_subscriptions;
DROP POLICY IF EXISTS "service_role only" ON push_subscriptions;

-- store_settings
DROP POLICY IF EXISTS "insert store_settings" ON store_settings;
DROP POLICY IF EXISTS "read store_settings" ON store_settings;
DROP POLICY IF EXISTS "update store_settings" ON store_settings;

-- daily_notes
DROP POLICY IF EXISTS "allow all" ON daily_notes;

-- monthly_sales
DROP POLICY IF EXISTS "allow_anon_all" ON monthly_sales;

-- rooms: 古いポリシーなし、削除不要

-- ============================================================
-- 確認クエリ（実行後にSupabase Dashboardで確認用）:
-- SELECT tablename, policyname FROM pg_policies
-- WHERE schemaname='public' AND policyname NOT LIKE 'rls_%'
-- AND tablename IN ('casts','shifts','reservations','customers','customer_visits',
--   'works','courses','options','cast_fees','cast_discounts','passkeys',
--   'push_subscriptions','store_settings','daily_notes','monthly_sales','rooms')
-- ORDER BY tablename, policyname;
-- → 結果が0行なら完了
-- ============================================================
