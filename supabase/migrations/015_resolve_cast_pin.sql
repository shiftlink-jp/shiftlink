-- ============================================================
-- ShiftLink: 名前選択なしPINログインの高速化（ブラインド索引）
--
-- 背景:
--   PINだけで本人特定する方式では、在籍キャスト全員ぶん bcrypt(強度12) を計算するため
--   4〜9秒かかっていた（bcryptは1件でも重く、人数ぶんは致命的）。
--
-- 対策（ブラインド索引）:
--   PIN を HMAC-SHA256(秘密ペッパー) で決定的にハッシュした pin_lookup を保存し、
--   索引一発で本人を引く（bcrypt を全員ぶん計算しない）。本人確認は bcrypt のままで、
--   一致候補1人だけを検証する。pin_lookup は anon から読めない auth_pins 内・
--   ペッパーは SECURITY DEFINER 関数内（API非公開）なので総当たり耐性を保つ。
--
--   既存PINは平文が無い（012でクリア済）ため pin_lookup を即時には作れない。
--   → ログイン時に bcrypt で一致した本人の pin_lookup を遅延バックフィルする。
--     各キャストの「初回ログインのみ」従来速度、以降はほぼ瞬時。
--     set_pin_hash 経由で新規/変更されたPINは即座に索引化される。
--
--   011/012 と同方針: SECURITY DEFINER / search_path='' / 完全修飾 / service_role 限定。
-- ============================================================

-- 1) 決定的ハッシュ列＋部分索引（キャストのみ）
ALTER TABLE public.auth_pins ADD COLUMN IF NOT EXISTS pin_lookup text;
CREATE INDEX IF NOT EXISTS auth_pins_lookup_idx
  ON public.auth_pins (COALESCE(store_id::text, '_default'), pin_lookup)
  WHERE principal LIKE 'cast.%';

-- 2) PINから在籍キャスト本人を特定（索引一発→未移行のみbcryptして自動バックフィル）
CREATE OR REPLACE FUNCTION public.resolve_cast_pin(p_store_id uuid, p_pin text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lookup text;
  v_id bigint;
  v_principal text;
BEGIN
  v_lookup := encode(extensions.hmac(p_pin, 'sl_pin_pepper_2026_a7f3e9c1b5d28406f1a3c7e90b2d4856', 'sha256'), 'hex');
  -- 高速パス: 索引一発（在籍者のみ）
  SELECT c.id INTO v_id
  FROM public.auth_pins ap
  JOIN public.casts c
    ON c.id = (split_part(ap.principal, '.', 2))::bigint
   AND c.store_id IS NOT DISTINCT FROM p_store_id
  WHERE ap.store_id IS NOT DISTINCT FROM p_store_id
    AND ap.principal LIKE 'cast.%'
    AND ap.pin_lookup = v_lookup
    AND COALESCE(c.active, true) = true
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- フォールバック: bcrypt照合（未移行）。一致したら索引を埋める。
  SELECT ap.principal, c.id INTO v_principal, v_id
  FROM public.auth_pins ap
  JOIN public.casts c
    ON c.id = (split_part(ap.principal, '.', 2))::bigint
   AND c.store_id IS NOT DISTINCT FROM p_store_id
  WHERE ap.store_id IS NOT DISTINCT FROM p_store_id
    AND ap.principal LIKE 'cast.%'
    AND COALESCE(c.active, true) = true
    AND ap.pin_hash = extensions.crypt(p_pin, ap.pin_hash)
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.auth_pins SET pin_lookup = v_lookup
    WHERE store_id IS NOT DISTINCT FROM p_store_id AND principal = v_principal;
    RETURN v_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_cast_pin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_cast_pin(uuid, text) TO service_role;

-- 3) set_pin_hash も pin_lookup を更新（新規/変更PINは即座に索引化）
CREATE OR REPLACE FUNCTION public.set_pin_hash(p_store_id uuid, p_principal text, p_pin text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.auth_pins (store_id, principal, pin_hash, pin_lookup)
  VALUES (
    p_store_id, p_principal,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    CASE WHEN p_principal LIKE 'cast.%'
         THEN encode(extensions.hmac(p_pin, 'sl_pin_pepper_2026_a7f3e9c1b5d28406f1a3c7e90b2d4856', 'sha256'), 'hex')
         ELSE NULL END
  )
  ON CONFLICT (COALESCE(store_id::text, '_default'), principal)
  DO UPDATE SET pin_hash = EXCLUDED.pin_hash, pin_lookup = EXCLUDED.pin_lookup, updated_at = now();
$$;
REVOKE ALL ON FUNCTION public.set_pin_hash(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pin_hash(uuid, text, text) TO service_role;
