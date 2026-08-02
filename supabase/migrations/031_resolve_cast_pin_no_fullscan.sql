-- ============================================================
-- 031: 誤PINのたびに在籍者全員ぶん bcrypt を回すのをやめる（DoS対策）
--
-- 背景:
--   015 の resolve_cast_pin は
--     ①索引(pin_lookup)で一発検索 → 見つからなければ
--     ②在籍キャスト全員の pin_hash に対して bcrypt(強度12) を総当たり照合
--   という作りで、②は「未移行（pin_lookup がまだ空）のキャストを救済する」ための経路。
--   ところが誤ったPINは必ず①で外れるため、誤PINが来るたびに②が走る。
--   在籍17名なら1回のログイン試行で bcrypt 17回。誤PINを大量に送られると
--   本番PostgresのCPUを食い潰し、営業中のアプリが止まる。
--
-- 対策:
--   ②の対象を「pin_lookup がまだ入っていない行」だけに限定する。
--   pin_lookup が入っている行は、同じPINから作った値を①で既に突き合わせ済みなので、
--   ②で bcrypt を掛け直しても結果は必ず不一致＝完全に無駄な計算。
--   （pin_hash と pin_lookup は set_pin_hash が同じPINから同時に書き、
--     015の遅延バックフィルも「bcryptで一致した本人のPIN」から書くため、両者は常に同じPIN由来）
--
--   結果、②のコストは「未移行の人数」ぶんだけになり、各自が1回ログインすれば0になる。
--   移行が終われば誤PINのコストは索引1回（ほぼ0）に落ちる。
--
-- 仕様は変えない:
--   ・PINのみログイン（cast_id を指定しない方式）はそのまま
--   ・未移行キャストの初回ログインは従来どおり bcrypt で救済され、索引も埋まる
--   ・015 のファイルは書き換えず、この031で関数を上書き（CREATE OR REPLACE）する
-- 再実行しても壊れない。
-- ============================================================

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

  -- フォールバック: bcrypt照合。★未移行（pin_lookup が空）の行のみを対象にする。
  --   索引済みの行をここで再照合しても必ず外れるため、掛けるだけ無駄＝DoSの温床だった。
  SELECT ap.principal, c.id INTO v_principal, v_id
  FROM public.auth_pins ap
  JOIN public.casts c
    ON c.id = (split_part(ap.principal, '.', 2))::bigint
   AND c.store_id IS NOT DISTINCT FROM p_store_id
  WHERE ap.store_id IS NOT DISTINCT FROM p_store_id
    AND ap.principal LIKE 'cast.%'
    AND ap.pin_lookup IS NULL
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
