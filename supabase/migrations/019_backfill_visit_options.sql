-- 019_backfill_visit_options.sql
-- 目的: 来店履歴(customer_visits)のオプションを、予約(reservations)の最新オプションに揃える。
--
-- 背景: セラピストの「追加OP」(castAddOption)が予約のみ更新し来店記録を更新していなかったため、
--       後から追加したオプションが来店履歴に反映されていなかった。コード側は修正済み(99478eb)だが、
--       修正前に追加された既存データはズレたままなので、ここで一括同期する。
--
-- 対象: kyoukano(PIN本番) = store_id IS NULL のデータのみ。
-- 安全性: reservation_idで紐づき、かつオプションが食い違う行のみ更新。冪等(何度実行しても同じ結果)。

-- ① 事前確認: 何件ズレているか（実行前に件数を見たい場合）
-- SELECT COUNT(*) AS mismatch_count
-- FROM customer_visits cv
-- JOIN reservations r ON cv.reservation_id = r.id
-- WHERE cv.store_id IS NULL
--   AND COALESCE(cv.options, '') <> COALESCE(r.options, '');

-- ② 本処理: 来店履歴のオプションを予約に合わせる
UPDATE customer_visits cv
SET options = r.options
FROM reservations r
WHERE cv.reservation_id = r.id
  AND cv.store_id IS NULL
  AND COALESCE(cv.options, '') <> COALESCE(r.options, '');
