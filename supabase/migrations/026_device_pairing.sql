-- ============================================================
-- 026_device_pairing.sql
-- ログインセキュリティ改修（①同僚PIN閲覧の遮断／②ロック単位／③端末ペアリング）
--
-- 設計書: docs/security-device-pairing-design.md
--
-- 核心: 「どの店舗か」の指定をクライアントからサーバー（端末トークン）へ移す。
--       これにより第三者が任意の店舗のログイン窓口を叩く経路そのものが消える。
--
-- ★適用順序★
--   このマイグレーションは「テーブル追加＋平文PINの金庫への移送」まで。
--   casts.pin の NULL クリアは、アプリ・Edge Function の新版が本番反映され
--   動作確認できた後に 027 で行う（先に消すとPINバッジ表示が壊れるため）。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 端末トークン（生トークンは保存しない。sha256ハッシュのみ）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_devices (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id     uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,       -- sha256(生トークン) の16進文字列
  label        text,                        -- 「かなさんのiPhone」等（任意）
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz                  -- 失効させた日時（NULLなら有効）
);
CREATE INDEX IF NOT EXISTS store_devices_store_idx ON store_devices(store_id);

-- ------------------------------------------------------------
-- 2. ペアリングコード（48時間有効・1回使い切り。平文は保存しない）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_pairing_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid NOT NULL,
  code_hash   text NOT NULL UNIQUE,         -- sha256(コード)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_pairing_codes_store_idx ON store_pairing_codes(store_id);

-- ------------------------------------------------------------
-- 3. RLS: 両テーブルとも「ポリシー無しで有効化」＝ service_role 以外は一切アクセス不可
--    （anon/authenticated からは存在すら読めない。Edge Function 経由のみ）
-- ------------------------------------------------------------
ALTER TABLE store_devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_pairing_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE store_devices       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE store_pairing_codes FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. ①: 平文PINを auth_pins（RLS全拒否）へ移送する
--    casts.pin はRLSが行単位のため同一店舗のセラピスト同士で読めてしまう。
--    auth_pins は 011 で service_role 以外アクセス不可になっているため安全。
--    ※ここでは casts.pin をまだ消さない（027で消す）。
-- ------------------------------------------------------------
ALTER TABLE auth_pins ADD COLUMN IF NOT EXISTS pin_plain text;

UPDATE auth_pins ap
   SET pin_plain = c.pin
  FROM casts c
 WHERE ap.principal = 'cast.' || c.id::text
   AND ap.store_id IS NOT DISTINCT FROM c.store_id
   AND c.pin IS NOT NULL
   AND ap.pin_plain IS NULL;

-- auth_pins に行が無い（PIN未設定 or 未移行）キャストの平文も保全しておく
-- ※ c.pin は text 以外の可能性があるため ::text で明示キャストする
--   （011 も c.pin::text の形。キャスト無しだと crypt() の関数解決に失敗し026全体がロールバックする）
INSERT INTO auth_pins (store_id, principal, pin_hash, pin_plain)
SELECT c.store_id, 'cast.' || c.id::text,
       extensions.crypt(c.pin::text, extensions.gen_salt('bf', 12)), c.pin::text
  FROM casts c
 WHERE c.pin IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM auth_pins ap
      WHERE ap.principal = 'cast.' || c.id::text
        AND ap.store_id IS NOT DISTINCT FROM c.store_id
   );

-- ------------------------------------------------------------
-- 5. ②: ロック記録を端末単位にできるようにする
--    principal に端末を含めるため、列追加は参照用（実キーは principal 文字列）
-- ------------------------------------------------------------
ALTER TABLE pin_login_attempts ADD COLUMN IF NOT EXISTS device_id bigint;

-- ============================================================
-- 確認用:
--   SELECT count(*) FROM auth_pins WHERE pin_plain IS NOT NULL;  -- 平文が金庫へ移った件数
--   SELECT count(*) FROM casts     WHERE pin IS NOT NULL;        -- まだ消していないので同数のはず
-- ============================================================
