-- ============================================================
-- 030: ログイン失敗回数の「原子的」記録
--
-- 背景（脆弱性）:
--   pin-login / pair-device は失敗回数を
--     ①DBから読む → ②アプリ側で +1 → ③書き戻す
--   の3手順で数えていた。誤PINを同時に何十本も投げると、全リクエストが
--   ②の前に①を済ませてしまい、全部が「1回目」として同じ値を書き戻す。
--   結果、上限（端末5回/店舗50回/未登録端末10回/ペアリング10回）に到達せず
--   ロックが実質無効化される（4桁PIN＝1万通りなので総当たりが現実的になる）。
--
-- 対策:
--   加算をDBの中で完結させる。INSERT ... ON CONFLICT DO UPDATE の SET 式で
--   「今テーブルに入っている値」を参照して +1 する。Postgres は同じ行に対する
--   同時更新を行ロックで直列化し、後続は「先行がコミットした最新の行」に対して
--   SET 式を評価し直す。したがって N 本同時でもカウントは必ず N まで進む。
--   ★アプリが読んだ値は一切使わない。
--
-- 既存挙動は維持する:
--   ・時間窓の外（updated_at が古い）ならカウントを 1 から数え直す
--   ・上限到達でロックし、その際 fail_count を 0 に戻す
--     （戻さないと解除直後の1回で即再ロックされ永久に解けない＝ノコギリ波）
--
-- 権限:
--   Edge Function は service_role で呼ぶ。anon / authenticated には実行させない。
--   （CREATE FUNCTION は既定で PUBLIC に EXECUTE が付くので明示的に REVOKE する）
--
-- 再実行しても壊れない（DROP IF EXISTS → CREATE）。
-- テーブル定義は 010（+026 で device_id 追加）のまま。変更しない。
-- ============================================================

DROP FUNCTION IF EXISTS public.record_login_fail(uuid, text, integer, integer, integer, bigint);

CREATE OR REPLACE FUNCTION public.record_login_fail(
  p_store_id      uuid,
  p_principal     text,
  p_max           integer,
  p_lock_minutes  integer,
  p_window_minutes integer,
  p_device_id     bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_next   integer;
  v_locked timestamptz := NULL;
BEGIN
  -- ① 原子的な加算（窓の外なら 1 から数え直す）
  INSERT INTO pin_login_attempts (store_id, principal, fail_count, locked_until, device_id, updated_at)
  VALUES (p_store_id, p_principal, 1, NULL, p_device_id, now())
  ON CONFLICT (store_id, principal) DO UPDATE
    SET fail_count = CASE
          WHEN pin_login_attempts.updated_at < now() - make_interval(mins => p_window_minutes)
            THEN 1
          ELSE pin_login_attempts.fail_count + 1
        END,
        locked_until = NULL,
        -- 診断用。呼び出し側が渡さなかった場合は既存値を消さない。
        device_id = COALESCE(EXCLUDED.device_id, pin_login_attempts.device_id),
        updated_at = now()
  RETURNING fail_count INTO v_next;

  -- ② 上限到達ならロック（同時に fail_count を 0 に戻す＝既存仕様）
  IF v_next >= p_max THEN
    v_locked := now() + make_interval(mins => p_lock_minutes);
    UPDATE pin_login_attempts
       SET fail_count = 0, locked_until = v_locked, updated_at = now()
     WHERE store_id = p_store_id AND principal = p_principal;
  END IF;

  RETURN jsonb_build_object(
    'fail_count', CASE WHEN v_locked IS NULL THEN v_next ELSE 0 END,
    'locked', v_locked IS NOT NULL,
    'locked_until', v_locked
  );
END;
$$;

-- 既定で PUBLIC に付く EXECUTE を剥がし、service_role だけに与える
REVOKE ALL ON FUNCTION public.record_login_fail(uuid, text, integer, integer, integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_login_fail(uuid, text, integer, integer, integer, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.record_login_fail(uuid, text, integer, integer, integer, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_fail(uuid, text, integer, integer, integer, bigint) TO service_role;
