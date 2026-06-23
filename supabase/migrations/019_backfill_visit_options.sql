-- 019_backfill_visit_options.sql
-- 目的: 来店履歴(customer_visits)のオプションを、予約(reservations)の最新オプションに揃える。
--
-- 背景: セラピストの「追加OP」(castAddOption)が予約のみ更新し来店記録を更新していなかったため、
--       後から追加したオプションが来店履歴に反映されていなかった。コード側は修正済み(99478eb)だが、
--       修正前に追加された既存データはズレたままなので、ここで一括同期する。
--
-- 対象store_id: kyoukano本番 = '4cb3383a-31e5-408a-9f75-60a25943ac4d'
--   （注: CLAUDE.mdには「既存PINデータはstore_id=NULL」とあるが、実本番調査の結果kyoukanoは
--    上記の正式なstore_idを持っていた。NULLではない。2026-06-23 本番SQLエディタで確認済み）
--
-- 重要な前提: 来店履歴785件のうち586件は reservation_id が NULL（旧方式で予約と未紐付け）。
--   これらは「行が存在するが紐付いていないだけ」なので、新規INSERTすると来店履歴が二重になり
--   来店回数が水増しされる。よって本マイグレーションは reservation_id で紐づく行のみを更新し、
--   未紐付けの行や行が無い予約には一切触れない（INSERTしない）。
--
-- 安全性: reservation_idで紐づき、かつオプションが食い違う行のみ更新。冪等。
--   2026-06-23 本番で実行済み（94件更新）。

UPDATE customer_visits cv
SET options = r.options
FROM reservations r
WHERE cv.reservation_id = r.id
  AND r.store_id = '4cb3383a-31e5-408a-9f75-60a25943ac4d'
  AND COALESCE(cv.options, '') <> COALESCE(r.options, '');
