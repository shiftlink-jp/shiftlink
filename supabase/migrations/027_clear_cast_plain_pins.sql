-- ============================================================
-- 027_clear_cast_plain_pins.sql
-- ①の最終段: casts.pin の平文を消す。
--
-- ★必ず以下がすべて本番反映され、動作確認できてから実行すること★
--   1) 026 適用済み（平文が auth_pins.pin_plain へ移送済み）
--   2) Edge Function manage-devices デプロイ済み（オーナー限定のPIN取得経路 action=list_pins）
--   3) set-pin 新版デプロイ済み（PIN変更時に pin_plain も更新する）
--   4) index.html 新版デプロイ済み（PINバッジが manage-devices(list_pins) から描画される）
--   これらより先に実行すると、管理画面のPINバッジが「未設定」表示になる。
--
-- 列は DROP しない（旧コードが列の存在を前提にしている可能性を考慮）。NULL化のみ。冪等。
-- ============================================================

-- 移送漏れが無いことを確認してから消す（漏れがあれば例外を投げて中断）
DO $$
DECLARE
  v_missing int;
BEGIN
  SELECT count(*) INTO v_missing
    FROM casts c
   WHERE c.pin IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM auth_pins ap
        WHERE ap.principal = 'cast.' || c.id::text
          AND ap.store_id IS NOT DISTINCT FROM c.store_id
          AND ap.pin_plain IS NOT NULL
     );
  IF v_missing > 0 THEN
    RAISE EXCEPTION '移送漏れが % 件あります。026を先に適用してください', v_missing;
  END IF;
END $$;

UPDATE casts SET pin = NULL WHERE pin IS NOT NULL;

-- 確認: SELECT count(*) FROM casts WHERE pin IS NOT NULL;  -- → 0
