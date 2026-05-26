-- ============================================================
-- エラーログ確認クエリ集
-- Supabase Dashboard → SQL Editor で実行
-- ============================================================

-- 1. 直近24時間のエラー一覧（新しい順）
SELECT
  created_at,
  user_name,
  CASE WHEN is_owner THEN '👑オーナー' ELSE '🧍キャスト' END AS role,
  error_type,
  error_message,
  context,
  url
FROM error_logs
WHERE created_at > now() - interval '24 hours'
ORDER BY created_at DESC
LIMIT 100;

-- 2. 今週のエラー集計（エラータイプ別）
SELECT
  error_type,
  COUNT(*) AS count,
  COUNT(DISTINCT user_name) AS affected_users,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM error_logs
WHERE created_at > now() - interval '7 days'
GROUP BY error_type
ORDER BY count DESC;

-- 3. 同じエラーメッセージで頻発しているもの（TOP 20）
SELECT
  error_message,
  COUNT(*) AS count,
  COUNT(DISTINCT user_name) AS affected_users,
  MAX(created_at) AS last_seen
FROM error_logs
WHERE created_at > now() - interval '7 days'
GROUP BY error_message
ORDER BY count DESC
LIMIT 20;

-- 4. 特定ユーザーのエラー履歴（user_nameを書き換えて使う）
-- SELECT created_at, error_type, error_message, context, url
-- FROM error_logs
-- WHERE user_name = 'キャスト名をここに'
-- ORDER BY created_at DESC LIMIT 50;

-- 5. 30日以上経過したログを削除（手動メンテナンス）
-- DELETE FROM error_logs WHERE created_at < now() - interval '30 days';
