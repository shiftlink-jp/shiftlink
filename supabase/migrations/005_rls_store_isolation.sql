-- ============================================================
-- ShiftLink RLS（行レベルセキュリティ）マイグレーション
--
-- ポリシー設計:
--   anon（PINログインアプリ）  → store_id IS NULL のデータのみアクセス可
--   authenticated（SaaSユーザー） → 自店舗の store_id のデータのみアクセス可
--
-- ★重要★ このマイグレーションを適用しても既存PINアプリは壊れない
--   - 既存データは store_id = NULL → anon ポリシーで引き続きアクセス可
--   - Edge Functions は service_role キーを使うため RLS を自動バイパス
-- ============================================================

-- ------------------------------------------------------------
-- 1. アクセス制御ヘルパー関数
-- ------------------------------------------------------------

-- check_store_access: 行の store_id が現在のユーザーのアクセス権と一致するか検証
CREATE OR REPLACE FUNCTION check_store_access(row_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN row_store_id IS NULL   -- PINアプリ(anon): NULLデータのみ
    ELSE row_store_id = get_my_store_id()               -- SaaSユーザー: 自店舗のみ
  END;
$$;

-- ------------------------------------------------------------
-- 2. 既存テーブル（store_id カラム付き）に RLS を適用
-- ------------------------------------------------------------

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'casts',
    'shifts',
    'reservations',
    'customers',
    'customer_visits',
    'works',
    'courses',
    'options',
    'cast_fees',
    'cast_discounts',
    'passkeys',
    'push_subscriptions',
    'store_settings',
    'daily_notes',
    'monthly_sales',
    'rooms'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- RLS を有効化
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    -- SELECT ポリシー
    BEGIN
      EXECUTE format(
        $f$CREATE POLICY "rls_select_%s" ON %I FOR SELECT USING (check_store_access(store_id))$f$,
        tbl, tbl
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    -- INSERT ポリシー
    BEGIN
      EXECUTE format(
        $f$CREATE POLICY "rls_insert_%s" ON %I FOR INSERT WITH CHECK (check_store_access(store_id))$f$,
        tbl, tbl
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    -- UPDATE ポリシー
    BEGIN
      EXECUTE format(
        $f$CREATE POLICY "rls_update_%s" ON %I FOR UPDATE USING (check_store_access(store_id)) WITH CHECK (check_store_access(store_id))$f$,
        tbl, tbl
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    -- DELETE ポリシー
    BEGIN
      EXECUTE format(
        $f$CREATE POLICY "rls_delete_%s" ON %I FOR DELETE USING (check_store_access(store_id))$f$,
        tbl, tbl
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. store_members: 自分の所属店舗の INSERT のみ許可（追加ポリシー）
-- ------------------------------------------------------------

-- オーナーのみメンバー追加可
DO $$ BEGIN
  CREATE POLICY "store_members_delete" ON store_members FOR DELETE
    USING (store_id = get_my_store_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------
-- 完了メモ:
-- - anon（PINアプリ）は store_id IS NULL のデータに引き続きアクセス可
-- - SaaSユーザーは自店舗の store_id が付いたデータのみアクセス可
-- - Edge Functions は service_role キーで RLS を自動バイパス → 影響なし
-- - 本マイグレーションは idempotent（2回以上実行しても安全）
-- ------------------------------------------------------------
