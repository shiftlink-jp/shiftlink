-- 036_applications.sql
-- 求人応募フォーム（面接タブ）。応募者がURLから自分で入力・写真を添付して送信する。
--   ・applications              : 応募1件＝1行。写真は Storage に置き、パスだけを持つ
--   ・store_settings.recruit_*  : 応募フォームのURL鍵・受付ON/OFF・LINEに貼る文章
--   ・storage: applicant-photos : 応募写真の非公開バケット
--
-- ★このテーブルだけ「オーナー限定」にしている★
--   名前・年齢・住所・身長・体重・カップ数・顔写真という、アプリ内で最も機微な情報を扱う。
--   他のテーブルは店舗単位の分離だが、ここはセラピスト（role='staff'）からも見えないよう
--   is_store_owner() を足して二重に絞る。UIで隠すだけでは、APIを直接叩けば読めてしまうため。
--
-- 設計メモ:
--   ・応募者は未ログイン。書き込みは service_role を使う Edge Function `submit-application` のみ。
--     そのため applications に INSERT ポリシーは**わざと作っていない**（RLSは該当ポリシーが
--     無ければ拒否するので、クライアントからの直接INSERTは通らない）。消さないこと。
--   ・写真のパスは <store_id>/<ランダムUUID>/1.jpg。応募IDは採番前なので使わない。
--   ・有効期限は設けない（求人広告に貼るため）。締め切りは recruit_enabled で切り替える。
--
-- ⚠️ SaaSで新規店舗を作るときは store_members に role='owner' の行が必要。
--    無いと、その店舗のオーナーには応募が1件も見えない。
--
-- 適用先: KYOUKANO本番(qgcgkrcrfzonmmygcdju) / SaaS開発(fewuonnrgqnxtopkjudt)

-- ------------------------------------------------------------
-- 1. 「このセッションは店舗オーナーか」を判定する関数
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_store_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM store_members
    WHERE user_id = auth.uid() AND role = 'owner'
  );
$$;

COMMENT ON FUNCTION is_store_owner() IS 'PIN/生体認証どちらのログインでも、オーナーは pin.owner.<store_id>@shiftlink.internal の決定的ユーザーに収束する（pin-login / passkey 関数）';

-- ------------------------------------------------------------
-- 2. applications テーブル
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
  id              bigserial PRIMARY KEY,
  store_id        uuid REFERENCES stores(id),
  name            text,
  age             integer,
  area            text,        -- お住まい（例: 名古屋市中区）
  height          integer,     -- cm
  weight          integer,     -- kg
  bust            text,        -- カップ数（A〜J）
  experience      text,        -- '未経験' / '経験あり'
  experience_note text,        -- 経験の詳細（任意）
  photo_paths     text[],      -- Storage上のパス（最大2枚）
  status          text DEFAULT '未対応',
  memo            text,        -- オーナーの控え
  ip_hash         text,        -- 連投制限用。生のIPは保存しない
  submitted_at    timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

-- 対応状況は決まった値だけ（UPDATE経由で妙な文字列が入らないように）
DO $$ BEGIN
  ALTER TABLE applications ADD CONSTRAINT applications_status_check
    CHECK (status IN ('未対応','連絡済み','面接済み','採用','不採用'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- カップ数も決まった値だけ（UPDATE経由で任意の文字列が入らないように）
DO $$ BEGIN
  ALTER TABLE applications ADD CONSTRAINT applications_bust_check
    CHECK (bust IS NULL OR bust IN ('A','B','C','D','E','F','G','H','I','J',''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_applications_store_id ON applications(store_id);
CREATE INDEX IF NOT EXISTS idx_applications_submitted_at ON applications(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_ip_hash ON applications(ip_hash, submitted_at DESC);

-- ------------------------------------------------------------
-- 3. RLS（自店舗 かつ オーナー のときだけ）
-- ------------------------------------------------------------
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "rls_select_applications" ON applications FOR SELECT
    USING (check_store_access(store_id) AND is_store_owner());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "rls_update_applications" ON applications FOR UPDATE
    USING (check_store_access(store_id) AND is_store_owner())
    WITH CHECK (check_store_access(store_id) AND is_store_owner());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "rls_delete_applications" ON applications FOR DELETE
    USING (check_store_access(store_id) AND is_store_owner());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- INSERT ポリシーは意図的に作らない（上のコメント参照）

GRANT SELECT, UPDATE, DELETE ON applications TO authenticated;

COMMENT ON TABLE applications IS '求人応募。オーナーのみ閲覧可（RLSで role=owner を要求）。書き込みは Edge Function のみ';

-- ------------------------------------------------------------
-- 4. 応募写真の保管庫（非公開バケット）
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('applicant-photos','applicant-photos', false, 8388608,
        ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- 写真もオーナーだけ。フォルダの1階層目が自店のIDであることを要求する
DO $$ BEGIN
  CREATE POLICY "applicant_photos_select" ON storage.objects FOR SELECT
    USING (bucket_id = 'applicant-photos'
           AND is_store_owner()
           AND (storage.foldername(name))[1] = get_my_store_id()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "applicant_photos_delete" ON storage.objects FOR DELETE
    USING (bucket_id = 'applicant-photos'
           AND is_store_owner()
           AND (storage.foldername(name))[1] = get_my_store_id()::text);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- アップロードは Edge Function（service_role）だけ。INSERT/UPDATEポリシーは作らない。

-- ------------------------------------------------------------
-- 5. 応募フォームの設定
-- ------------------------------------------------------------
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS recruit_token uuid;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS recruit_enabled boolean DEFAULT true;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS recruit_copy_message text;
-- 応募フォームに表示する店名。URLをコピーしたときにアプリ側の店名を写す
-- （stores.name は「KYOUKANO」だが、アプリの表示は「KYOUKANO NAGOYA」のため揃える）
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS recruit_store_name text;

-- token から店舗を1つに特定できること（重複していると別店舗に応募が入る）
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_settings_recruit_token
  ON store_settings(recruit_token) WHERE recruit_token IS NOT NULL;
