-- ============================================================
-- 本番 cast_fees に欠落していた extra_trial_op_backs 列を追加
--
-- 背景:
--   003_extra_json_columns.sql は cast_fees に3つのJSONB列を追加する設計だが、
--   本番(qgcgkrcrfzonmmygcdju)には extra_course_backs / extra_op_backs の2つしか
--   適用されておらず、extra_trial_op_backs が欠落していた。
--   アプリの saveFee() は常に extra_trial_op_backs を書き込むため、
--   委託金設定の保存が PGRST204（列が存在しない）で失敗していた。
--
-- 影響:
--   - 追加のみ・既存データ不変（DEFAULT '{}'）。KYOUKANO既存データに影響なし。
--   - これにより委託金設定の保存が本番で正常化する。
--   - IF NOT EXISTS で冪等（dev等すでに存在する環境でも安全）。
-- ============================================================

ALTER TABLE cast_fees ADD COLUMN IF NOT EXISTS extra_trial_op_backs jsonb DEFAULT '{}';
