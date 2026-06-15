-- ============================================================
-- ShiftLink: 名前選択なしPINログインの高速化
--
-- 背景:
--   セラピストの「名前選択を廃止しPINだけで本人特定」する方式では、
--   pin-login が在籍キャスト全員ぶん verify_pin(bcrypt) を呼ぶため、
--   人数×bcrypt(強度12) のうえ各呼び出しがネットワーク往復で、4〜5秒かかっていた。
--
-- 対策:
--   照合ループを DB 内の1関数 resolve_cast_pin に閉じ込め、1往復で完結させる。
--   bcrypt 計算量自体は同じだが、N回の PostgREST/HTTP 往復が消えて大幅に短縮される。
--   退店(active=false)は対象外（在籍者のみログイン可）。
--
--   011/012 と同方針: SECURITY DEFINER / search_path='' / 完全修飾 / service_role 限定。
--
-- 適用:
--   本番(qgcgkrcrfzonmmygcdju)へこのSQLを実行。pin-login は本関数を優先し、
--   未デプロイ時は従来ループにフォールバックする（後方互換・適用順序非依存）。
-- ============================================================

-- 入力PINと在籍キャストのbcryptを DB 内で一括照合し、一致した cast_id を返す（無ければ NULL）
CREATE OR REPLACE FUNCTION public.resolve_cast_pin(p_store_id uuid, p_pin text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id
  FROM public.casts c
  JOIN public.auth_pins ap
    ON ap.store_id IS NOT DISTINCT FROM p_store_id
   AND ap.principal = 'cast.' || c.id::text
  WHERE c.store_id IS NOT DISTINCT FROM p_store_id
    AND COALESCE(c.active, true) = true
    AND ap.pin_hash = extensions.crypt(p_pin, ap.pin_hash)
  LIMIT 1;
$$;

-- anon/authenticated からは叩けないようにし、service_role(=pin-login)のみ実行可
REVOKE ALL ON FUNCTION public.resolve_cast_pin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_cast_pin(uuid, text) TO service_role;
