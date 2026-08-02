-- ============================================================
-- 029: セラピストごとの招待リンク
--   目的: 「店舗コードを手入力」「全員共通の招待リンク」の2本立てをやめ、
--         セラピスト管理の各カードの「招待」ボタン1つに一本化する。
--         オーナーはその人専用のURLをLINEで送るだけ。本人はタップしてPINでログイン。
--
-- 追加するもの:
--   store_pairing_codes.cast_id     … このコードは誰用か（NULL＝従来どおり誰でも使える店舗コード）
--   store_devices.bound_cast_id     … この端末は誰専用か（NULL＝制限なし）
--
-- 既存データへの影響: どちらも新規列でNULL。
--   ・既存の店舗コード行 → cast_id NULL ＝ これまでと完全に同じ挙動
--   ・既存の登録端末     → bound_cast_id NULL ＝ 誰でもログインできる（KYOUKANOは全てこちら）
--   ・既に配ってある全員共通の招待リンクも、そのまま使えるままにしてある
--     （止めたい場合はアプリの「端末の管理」→「共通の招待リンクを失効させる」を押す）
--
-- 外部キーは張らない: 退店処理(deleteCast)は casts の行を実際に削除するため、
--   FKを張ると退店処理が失敗する。ON DELETE SET NULL も「退店した人の端末が
--   誰でも使える端末に戻る」ため危険。参照が切れた場合はオーナーのみ使える端末として
--   振る舞う（＝安全側に倒れる）。
--
-- 再実行しても壊れない（IF NOT EXISTS）。適用は手動（オーナー実施）。
-- ============================================================

-- 1) コードに「誰用か」を持たせる
ALTER TABLE store_pairing_codes
  ADD COLUMN IF NOT EXISTS cast_id integer;   -- NULL=誰でも使える店舗コード / 値あり=その人専用

-- 2) 端末に「誰専用か」を持たせる
ALTER TABLE store_devices
  ADD COLUMN IF NOT EXISTS bound_cast_id integer;  -- NULL=制限なし（既存端末は全てこれ）

-- 3) 「同時に有効な招待は1本」の制約を、店舗単位から「店舗×セラピスト単位」へ広げる。
--    028 の索引は store_id だけのUNIQUEなので、2人目の招待発行が弾かれてしまう。
--    COALESCE(cast_id,-1) で「共通リンク(NULL)は従来どおり1店舗1本」も維持する。
DROP INDEX IF EXISTS store_pairing_codes_one_invite;
CREATE UNIQUE INDEX IF NOT EXISTS store_pairing_codes_one_invite_per_cast
  ON store_pairing_codes(store_id, COALESCE(cast_id, -1))
  WHERE multi_use AND revoked_at IS NULL;

-- 4) 端末一覧・ログイン時の絞り込み用
CREATE INDEX IF NOT EXISTS store_devices_bound_cast_idx
  ON store_devices(store_id, bound_cast_id)
  WHERE bound_cast_id IS NOT NULL;

COMMENT ON COLUMN store_pairing_codes.cast_id     IS 'NULL=誰でも使える店舗コード。値あり=そのセラピスト専用の招待コード';
COMMENT ON COLUMN store_devices.bound_cast_id     IS 'NULL=制限なし。値あり=その本人とオーナーだけがこの端末からログインできる';

-- ============================================================
-- 確認用:
--   SELECT count(*) FROM store_devices WHERE bound_cast_id IS NOT NULL;  -- 適用直後は 0 のはず
--   SELECT count(*) FROM store_pairing_codes WHERE cast_id IS NOT NULL;  -- 適用直後は 0 のはず
-- ============================================================
