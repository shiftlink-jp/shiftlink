-- 014_passkey_webauthn.sql
-- 生体認証(パスキー/WebAuthn)をサーバ側で「本当に」検証するための列・テーブル追加。
--
-- 背景: 旧passkeysはサーバ検証が無く、public_keyにはclientDataJSON(検証不能なゴミ)が
--       入っていた。anonが開いていた前提の簡易ロックに過ぎず、PIN認証カットオーバー後は使えない。
-- 本migration後は新Edge Function `passkey` が本物のCOSE公開鍵を pk_format='v2' で保存し、
-- 署名検証に成功した時だけ pin-login と同じ安全なセッションを発行する。
-- 旧行(pk_format IS NULL)は検証対象から除外され、ユーザーは各自1回だけ再登録する。

-- passkeys: 新方式に必要な列を追加（既存行・既存挙動には影響しない）
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS counter    bigint NOT NULL DEFAULT 0;  -- 署名カウンタ(クローン検知)
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS pk_format  text;                       -- 'v2'=本物のCOSE公開鍵を保存済み
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS transports text;                       -- 認証器のtransports(任意)
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- WebAuthnチャレンジの一時保管。options発行時にINSERT→verify時に消費(単回・5分TTL)。
-- Edge Function(service_role)のみが読み書きする。
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge  text NOT NULL,
  purpose    text NOT NULL,                 -- 'register' | 'authenticate'
  store_id   uuid,
  cast_id    integer,
  user_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

-- anon/authenticated からの直接アクセスを全拒否(ポリシー無し=拒否)。service_roleはRLSをバイパス。
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
