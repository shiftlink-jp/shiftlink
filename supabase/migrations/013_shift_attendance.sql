-- ============================================================
-- シフト出勤ステータス（出勤予定 / 出勤中 / 退勤済み）
--
-- shifts に出退勤の打刻時刻を2列追加する。ステータスは打刻の有無から導出:
--   clock_in_at IS NULL                       → 出勤予定
--   clock_in_at IS NOT NULL, clock_out_at NULL → 出勤中
--   clock_out_at IS NOT NULL                  → 退勤済み
--
-- キャストが本日ページの「出勤」「退勤」ボタンで自分のシフトを打刻し、
-- オーナーは本日ページのバッジで状況を一覧できる。
-- 実時刻を残すため将来の勤怠集計にも使える（reservations.room_in_at/out_at とは別物）。
--
-- 既存行は全て clock_in_at/clock_out_at = NULL（=出勤予定扱い）になるだけで影響なし。
-- RLSは shifts 既存ポリシー（store_id ベース）に従うため追加不要。
-- ============================================================

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS clock_in_at  timestamptz;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS clock_out_at timestamptz;
