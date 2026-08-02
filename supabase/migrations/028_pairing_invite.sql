-- ============================================================
-- 028: 招待リンク（複数人が使える店舗コード）
--   目的: セラピスト15名の端末登録を「1本のリンクをLINEで配る」だけで済ませる。
--   従来の store_pairing_codes は 48時間・1回使い切り。ここに「複数回使える」概念を足す。
--
-- 既存行への影響: multi_use は DEFAULT false のため、既存の行・既存の issue_code は
--   これまでと完全に同じ挙動（1回使い切り）のまま。revoked_at も NULL のままで無効化されない。
--
-- 再実行しても壊れない（IF NOT EXISTS）。適用は手動（オーナー実施）。
-- ============================================================

ALTER TABLE store_pairing_codes
  ADD COLUMN IF NOT EXISTS multi_use  boolean NOT NULL DEFAULT false,  -- true=招待リンク（何人でも使える）
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,                     -- 再発行で古いリンクを失効させた日時
  ADD COLUMN IF NOT EXISTS label      text;                            -- 用途メモ（例: 招待リンク）

-- 同時に有効な招待リンクは「1店舗1本」だけ。
-- Edge Function 側でも古い行を失効させるが、二重クリック等の競合はDBで弾く。
CREATE UNIQUE INDEX IF NOT EXISTS store_pairing_codes_one_invite
  ON store_pairing_codes(store_id)
  WHERE multi_use AND revoked_at IS NULL;

-- 招待コードの照合を速くする（コード照合自体は code_hash の UNIQUE を使う）
CREATE INDEX IF NOT EXISTS store_pairing_codes_invite_idx
  ON store_pairing_codes(store_id, expires_at)
  WHERE multi_use;

COMMENT ON COLUMN store_pairing_codes.multi_use  IS 'true=招待リンク用。使用済みにせず何人でも登録できる（有効期限内・上限内）';
COMMENT ON COLUMN store_pairing_codes.revoked_at IS 'NULL以外なら無効。招待リンクの再発行時に古い行へ入る';
