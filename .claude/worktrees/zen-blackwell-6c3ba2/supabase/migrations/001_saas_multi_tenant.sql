-- ============================================================
-- ShiftLink SaaS マルチテナント マイグレーション（安全版）
-- 本番環境（qgcgkrcrfzonmmygcdju）に適用
--
-- ★重要★ 既存のPINログインアプリを壊さないため:
--   - store_id は NULL許可（既存データはNULLのまま）
--   - RLSは新規テーブル（stores, store_members）のみ有効化
--   - 既存テーブルのRLSはSaaS完全移行時に別途有効化
-- ============================================================

-- 1. SaaS用テーブル作成
-- ============================================================

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  owner_email text,
  owner_user_id uuid REFERENCES auth.users(id),
  plan text DEFAULT 'free',
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text DEFAULT 'trialing',
  trial_ends_at timestamptz DEFAULT now() + interval '14 days',
  created_at timestamptz DEFAULT now(),
  settings jsonb DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS store_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','manager','staff')),
  cast_id integer,
  created_at timestamptz DEFAULT now(),
  UNIQUE(store_id, user_id)
);

-- 2. 既存テーブルに store_id カラム追加（NULLable — 既存データはNULLのまま）
-- ============================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'casts','shifts','reservations','customers','customer_visits',
    'works','courses','options','cast_fees','cast_discounts',
    'passkeys','push_subscriptions','store_settings','daily_notes','monthly_sales'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=tbl AND column_name='store_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN store_id uuid REFERENCES stores(id)', tbl);
    END IF;
  END LOOP;
END $$;

-- 3. インデックス追加
-- ============================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'casts','shifts','reservations','customers','customer_visits',
    'works','courses','options','cast_fees','cast_discounts',
    'passkeys','push_subscriptions','store_settings','daily_notes','monthly_sales'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_store_id ON %I(store_id)', tbl, tbl);
  END LOOP;
END $$;

-- 4. 関数作成
-- ============================================================

-- get_my_store_id: 認証ユーザーの所属store_idを返す
CREATE OR REPLACE FUNCTION get_my_store_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT store_id FROM store_members WHERE user_id = auth.uid() LIMIT 1;
$$;

-- create_store: 新規店舗作成 + オーナーメンバー登録
CREATE OR REPLACE FUNCTION create_store(p_name text, p_slug text, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_store_id uuid;
BEGIN
  INSERT INTO stores (name, slug, owner_email, owner_user_id)
  VALUES (p_name, p_slug, p_email, auth.uid())
  RETURNING id INTO new_store_id;

  INSERT INTO store_members (store_id, user_id, role)
  VALUES (new_store_id, auth.uid(), 'owner');

  RETURN new_store_id;
END;
$$;

-- 5. RLS（新規テーブルのみ — 既存テーブルは触らない）
-- ============================================================

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;

-- stores: 所属メンバーのみ参照可、オーナーのみ更新可
DO $$ BEGIN
  CREATE POLICY "stores_select" ON stores FOR SELECT
    USING (id IN (SELECT store_id FROM store_members WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "stores_update" ON stores FOR UPDATE
    USING (owner_user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE store_members ENABLE ROW LEVEL SECURITY;

-- store_members: 自分のレコード or 同じ店舗のメンバー参照可
DO $$ BEGIN
  CREATE POLICY "store_members_select" ON store_members FOR SELECT
    USING (user_id = auth.uid() OR store_id = get_my_store_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "store_members_insert" ON store_members FOR INSERT
    WITH CHECK (store_id = get_my_store_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 完了メモ:
-- - 既存データの store_id は NULL → 既存PINログインアプリに影響なし
-- - SaaSモードの新規データは store_id 付きで INSERT される
-- - 既存テーブルのRLS有効化は、SaaS完全移行後に別マイグレーションで実施
-- ============================================================
