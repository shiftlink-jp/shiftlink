-- ============================================================
-- ShiftLink 代理店紹介コード機能 マイグレーション（フェーズA: 記録＋集計）
-- 本番（qgcgkrcrfzonmmygcdju）には自動適用しない。手動適用前提。
--
-- ★重要★ 既存PINアプリ（store_id=NULL=KYOUKANO）への影響ゼロ:
--   - referral_partners は完全な新規テーブル（既存に触れない）
--   - stores への列追加は NULL許容で既存行は NULL のまま
--   - RLS は運営者のみ参照、店舗からは不可視
--   - コード照合だけは SECURITY DEFINER の RPC でサインアップ時に解決
-- ============================================================

-- 1. referral_partners テーブル（代理店マスタ）
-- ============================================================
CREATE TABLE IF NOT EXISTS referral_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,                 -- 紹介コード（店舗が入力する文字列）
  name text NOT NULL,                        -- 代理店名
  commission_rate numeric DEFAULT 20,        -- 料率%（将来用・フェーズAでは集計に未使用でも保持）
  active boolean DEFAULT true,               -- 無効化フラグ（解約代理店など）
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_partners_code ON referral_partners(code);
-- 大文字小文字を区別しない一意制約（'ABC' と 'abc' の重複登録を防ぐ。
-- 照合 resolve_referral_code が lower() で比較するため、登録側も一意性を揃える）
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_partners_code_lower ON referral_partners(lower(code));

-- 2. stores に紹介元を記録する列を追加（NULL許容・既存行は NULL のまま）
-- ============================================================
-- 既存設計（stores は uuid 参照中心）に合わせ、外部キー参照で記録する。
-- referral_code（入力された生コード）も監査用に保持しておく。
DO $$ BEGIN
  ALTER TABLE stores ADD COLUMN referred_by uuid REFERENCES referral_partners(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE stores ADD COLUMN referral_code text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_stores_referred_by ON stores(referred_by);

-- 3. RLS（運営者のみ参照可。一般店舗からは不可視）
-- ============================================================
ALTER TABLE referral_partners ENABLE ROW LEVEL SECURITY;

-- 運営者判定: Supabase Auth が確定したメール（auth.jwt()->>'email'）が
-- 運営者メールと一致するかで判定する。
-- ★stores.owner_email は create_store の任意入力（自己申告）で詐称可能なため使わない。
--   JWT(JSON Web Token=ログイン時にSupabaseが発行する改ざん不可な認証情報)内の
--   email はサインアップ済みの確定値なので、これを信頼の根拠にする。
-- ※将来複数運営者にするならこの関数を拡張する。
CREATE OR REPLACE FUNCTION is_platform_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT lower(coalesce(auth.jwt()->>'email','')) = lower('rrrkkk0924@icloud.com');
$$;

-- 運営者のみ全 referral_partners を CRUD 可
DO $$ BEGIN
  CREATE POLICY "referral_partners_operator_select" ON referral_partners FOR SELECT
    USING (is_platform_operator());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "referral_partners_operator_insert" ON referral_partners FOR INSERT
    WITH CHECK (is_platform_operator());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "referral_partners_operator_update" ON referral_partners FOR UPDATE
    USING (is_platform_operator()) WITH CHECK (is_platform_operator());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "referral_partners_operator_delete" ON referral_partners FOR DELETE
    USING (is_platform_operator());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. サインアップ時のコード解決 RPC（誰でも呼べるが、partner情報は最小限のみ返す）
-- ============================================================
-- 店舗は referral_partners を直接 SELECT できない（RLSで不可視）ため、
-- code → partner_id を解決する専用関数を SECURITY DEFINER で提供する。
-- 有効(active=true)なコードのみ解決。無効・不正コードは NULL を返す
-- （クライアント側で「無視して登録続行」できるようにする）。
CREATE OR REPLACE FUNCTION resolve_referral_code(p_code text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM referral_partners
  WHERE active = true
    AND lower(code) = lower(trim(p_code))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION resolve_referral_code(text) TO anon, authenticated;

-- 5. 店舗に紹介元を記録する RPC（自店舗のみ・サインアップ直後に呼ぶ）
-- ============================================================
-- RLSで stores.update は owner_user_id 限定。紹介元の記録もこの経路に従う。
-- p_code から partner を解決して referred_by / referral_code を自店舗に書く。
CREATE OR REPLACE FUNCTION set_store_referral(p_store_id uuid, p_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_partner uuid;
BEGIN
  -- 呼び出し元が当該店舗のオーナーであることを確認
  IF NOT EXISTS (
    SELECT 1 FROM stores WHERE id = p_store_id AND owner_user_id = auth.uid()
  ) THEN
    RETURN; -- 権限なし: 黙って何もしない（登録を妨げない）
  END IF;

  v_partner := resolve_referral_code(p_code);
  IF v_partner IS NULL THEN
    RETURN; -- 不正・無効コードは無視（登録続行）
  END IF;

  UPDATE stores
    SET referred_by = v_partner, referral_code = trim(p_code)
    WHERE id = p_store_id;
END;
$$;

GRANT EXECUTE ON FUNCTION set_store_referral(uuid, text) TO authenticated;

-- 6. 代理店別の集計ビュー（運営者のみ参照）
-- ============================================================
-- 紹介した店舗数・継続課金中(active)の店舗数を集計。
CREATE OR REPLACE FUNCTION referral_partner_stats()
RETURNS TABLE (
  partner_id uuid,
  code text,
  name text,
  commission_rate numeric,
  active boolean,
  referred_count bigint,
  paying_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    rp.id,
    rp.code,
    rp.name,
    rp.commission_rate,
    rp.active,
    count(s.id)                                         AS referred_count,
    count(s.id) FILTER (WHERE s.subscription_status = 'active') AS paying_count
  FROM referral_partners rp
  LEFT JOIN stores s ON s.referred_by = rp.id
  WHERE is_platform_operator()
  GROUP BY rp.id, rp.code, rp.name, rp.commission_rate, rp.active, rp.created_at
  ORDER BY rp.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION referral_partner_stats() TO authenticated;

-- ============================================================
-- 完了メモ:
-- - referral_partners は新規テーブル。既存テーブル/データに影響なし。
-- - stores.referred_by / referral_code は NULL許容、既存行は NULL のまま。
-- - 一般店舗オーナーは referral_partners を直接見られない（RLSで遮断）。
-- - コード解決は resolve_referral_code / set_store_referral RPC 経由のみ。
-- - 集計は referral_partner_stats() を運営者が呼ぶ（運営者以外は0行）。
-- - 本ファイルは idempotent（再実行可能）。
-- ============================================================
