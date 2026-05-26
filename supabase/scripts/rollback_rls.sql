-- ============================================================
-- 緊急ロールバック：RLSを全テーブルで無効化
-- 何か問題が起きたらSupabase Dashboard → SQL Editor で即座にこれを実行
-- 既存のポリシー定義は削除せず、RLS自体だけ無効化する（再有効化が容易）
-- ============================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'casts','shifts','reservations','customers','customer_visits',
    'works','courses','options','cast_fees','cast_discounts',
    'passkeys','push_subscriptions','store_settings','daily_notes',
    'monthly_sales','rooms'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', tbl);
    RAISE NOTICE 'Disabled RLS on table: %', tbl;
  END LOOP;
END $$;

-- 確認：全テーブルでrls_enabled=falseになっているはず
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname='public' AND tablename IN (
  'casts','shifts','reservations','customers','customer_visits',
  'works','courses','options','cast_fees','cast_discounts',
  'passkeys','push_subscriptions','store_settings','daily_notes',
  'monthly_sales','rooms'
)
ORDER BY tablename;
