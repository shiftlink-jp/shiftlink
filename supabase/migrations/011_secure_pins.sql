-- ============================================================
-- ShiftLink PIN隔離マイグレーション（#1 権限昇格対策）
--
-- 背景:
--   従来 owner_pin は store_settings、cast の pin は casts に「平文」で保存され、
--   RLS(check_store_access)が同一店舗内を無制限に許すため、PINログインした
--   一般キャスト(staff)が store_settings.owner_pin / 他キャストの casts.pin を
--   そのまま SELECT できた（→ オーナー権限奪取・なりすまし）。
--
-- 対策:
--   PIN本体を RLS全拒否の専用テーブル auth_pins へ隔離し、bcrypt（pgcrypto crypt）の
--   slow hash で保存する。auth_pins は service_role 以外アクセス不可。
--   ハッシュ計算・照合は すべて Postgres 内（verify_pin / set_pin_hash 関数）で行い、
--   Edge Function(Deno)はそれらを service_role で呼ぶだけ（言語間のハッシュ不整合を排除）。
--   これにより casts.pin / store_settings.owner_pin を NULL 化しても（→012）、
--   キャストは PIN もハッシュも一切取得できない。
--
-- なぜ bcrypt か（SHA-256ではなく）:
--   PINは数字のみ・短い＝鍵空間が小さいため、高速ハッシュ(SHA-256)はバックアップ流出時に
--   総当たりで即破られる。bcrypt等の slow/メモリ困難なKDFでオフライン総当たりコストを上げる。
--   （オンライン総当たりは pin_login_attempts(010) で別途レート制限済み）
--
-- ★無停止移行のための順序★
--   011 は「平文を残したまま」auth_pins を作り既存PINをハッシュ移行する（冪等）。
--   平文の NULL クリアは 012 で行う。
--   本番適用順序: pin-login新版/set-pin/index.html新版を反映 → 011 → 012
--   （詳細は docs/secure-pins-runbook.md 参照）
-- ============================================================

-- pgcrypto（crypt / gen_salt 用）。Supabaseでは extensions スキーマ。
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 1. PIN隔離テーブル（bcrypt はソルトをハッシュ文字列に内包するため salt 列は不要）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_pins (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid,                       -- NULL=レガシーPINアプリ（KYOUKANOはバックフィル後UUID）
  principal   text NOT NULL,              -- 'owner' / 'cast.{cast_id}'
  pin_hash    text NOT NULL,              -- bcrypt: crypt(pin, gen_salt('bf',12))
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- store_id が NULL でも principal で一意に保てるよう、COALESCE で複合ユニーク
-- （customer_no と同じ手法。Postgres は UNIQUE 制約だと NULL を別扱いしてしまうため）
CREATE UNIQUE INDEX IF NOT EXISTS auth_pins_store_principal_uniq
  ON auth_pins (COALESCE(store_id::text, '_default'), principal);

-- RLS有効・ポリシーなし → anon / authenticated は一切アクセス不可。
-- service_role（verify_pin / set_pin_hash 経由）のみが RLS をバイパスして読み書きする。
ALTER TABLE auth_pins ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 1.5 平文PIN列の NOT NULL を外す（あれば）
--   - 新クライアントは casts を pin なしで INSERT する（PINは set-pin 経由）
--   - 012 で平文列を NULL クリアする
--   既に nullable なら no-op（DROP NOT NULL は冪等）。
-- ------------------------------------------------------------
ALTER TABLE casts          ALTER COLUMN pin       DROP NOT NULL;
ALTER TABLE store_settings ALTER COLUMN owner_pin DROP NOT NULL;

-- ------------------------------------------------------------
-- 2. 既存の平文PINを bcrypt 化して移行（平文は温存。NULL化は012）
-- ------------------------------------------------------------

-- owner_pin
INSERT INTO auth_pins (store_id, principal, pin_hash)
SELECT ss.store_id, 'owner',
       extensions.crypt(ss.owner_pin::text, extensions.gen_salt('bf', 12))
FROM store_settings ss
WHERE ss.owner_pin IS NOT NULL AND length(ss.owner_pin::text) > 0
ON CONFLICT (COALESCE(store_id::text, '_default'), principal) DO NOTHING;

-- cast の pin
INSERT INTO auth_pins (store_id, principal, pin_hash)
SELECT c.store_id, 'cast.' || c.id,
       extensions.crypt(c.pin::text, extensions.gen_salt('bf', 12))
FROM casts c
WHERE c.pin IS NOT NULL AND length(c.pin::text) > 0
ON CONFLICT (COALESCE(store_id::text, '_default'), principal) DO NOTHING;

-- ------------------------------------------------------------
-- 3. 照合 / 設定 関数（SECURITY DEFINER・service_role 専用）
--    Edge Function はこれらを RPC で呼ぶだけ。ハッシュ計算はDB内に閉じる。
--    search_path='' ＋ 完全修飾で関数ハイジャックを防止。
-- ------------------------------------------------------------

-- 照合: auth_pins の bcrypt と pin を比較し true/false を返す
CREATE OR REPLACE FUNCTION public.verify_pin(p_store_id uuid, p_principal text, p_pin text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_pins
    WHERE store_id IS NOT DISTINCT FROM p_store_id
      AND principal = p_principal
      AND pin_hash = extensions.crypt(p_pin, pin_hash)
  );
$$;

-- 設定: bcrypt でハッシュ化して upsert（呼び出し側=set-pin がオーナー権限を検証済みの前提）
CREATE OR REPLACE FUNCTION public.set_pin_hash(p_store_id uuid, p_principal text, p_pin text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.auth_pins (store_id, principal, pin_hash)
  VALUES (p_store_id, p_principal, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)))
  ON CONFLICT (COALESCE(store_id::text, '_default'), principal)
  DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now();
$$;

-- ★重要★ EXECUTE 権限を service_role のみに絞る。
--   Supabase は public スキーマの関数に対し anon/authenticated へ EXECUTE を
--   デフォルト自動付与するため、PUBLIC だけでなく anon/authenticated からも明示 REVOKE する。
--   これを怠ると anon が PostgREST RPC で verify_pin（PINオラクル）や
--   set_pin_hash（任意PIN設定）を直接叩けてしまう。
REVOKE ALL ON FUNCTION public.verify_pin(uuid, text, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_pin_hash(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_pin(uuid, text, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.set_pin_hash(uuid, text, text) TO service_role;

-- ------------------------------------------------------------
-- 確認クエリ（適用後の手動確認用）:
--   SELECT principal, store_id, left(pin_hash,7)||'…' AS h FROM auth_pins ORDER BY principal;
--     → owner / cast.* が並び、pin_hash が '$2a$12$…'（bcrypt）であること
--   SELECT public.verify_pin('<store_id>'::uuid, 'owner', '<正しいPIN>');  -- → t
--   SELECT public.verify_pin('<store_id>'::uuid, 'owner', '<誤ったPIN>');  -- → f
-- ============================================================
