-- 021_reservation_public_link.sql
-- お客さん向け「予約詳細の公開閲覧URL」機能。
--   ・reservations.public_token   : 推測不能なランダム鍵（URLに載せる。予約IDは連番のため使わない）
--   ・reservations.public_snapshot: URL作成時点の表示内容スナップショット（予約日・入室時間・
--                                    セラピスト名・氏名区分・コース・支払い方法・金額・ルーム住所 等）
--   ・rooms.address               : ルームごとの住所（公開ページに表示）
-- 既存データ・既存挙動には影響しない（すべて NULL 許容の追加カラム）。

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS public_token uuid;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS public_snapshot jsonb;

-- token はグローバルに一意（別店舗含め衝突しない）
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_public_token
  ON reservations(public_token) WHERE public_token IS NOT NULL;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS address text;

-- 注意: このテーブルは RLS 有効。公開ページは anon で直接読めない（意図的）。
--   閲覧は service_role を使う Edge Function `get-reservation-public` がトークン照合して1件だけ返す。
