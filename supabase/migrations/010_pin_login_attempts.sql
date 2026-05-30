-- ============================================================
-- pin-login のブルートフォース対策：試行回数・ロックアウト記録テーブル
--
-- 4桁PIN等は総当たり可能なため、pin-login関数がこのテーブルで
-- 失敗回数を数え、一定回数でロックする。
--
-- アクセス制御:
--   RLS有効・ポリシーなし → anon/authenticated は一切アクセス不可。
--   pin-login関数(service_role)のみがRLSをバイパスして読み書きする。
-- 追加のみ・既存データ不変。
-- ============================================================

CREATE TABLE IF NOT EXISTS pin_login_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id     uuid NOT NULL,
  principal    text NOT NULL,           -- 'owner.{store_id}' / 'cast.{cast_id}.{store_id}'
  fail_count   int  NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, principal)
);

ALTER TABLE pin_login_attempts ENABLE ROW LEVEL SECURITY;
-- ポリシーを作らない＝service_role以外は全拒否
