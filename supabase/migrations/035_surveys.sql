-- 035_surveys.sql
-- 施術後アンケート（お客様が星5段階で4項目を評価する）。
--   ・surveys                  : アンケート1件＝予約1件。token(推測不能なUUID)でお客様の画面と紐づく
--   ・store_settings.survey_copy_message : アンケートURLと一緒にLINEへ貼る文章（店舗ごとに編集可）
--
-- 設計メモ:
--   ・お客様の画面(s.html)は未ログイン。読み書きは service_role を使う Edge Function
--     `submit-survey` がトークン照合して1件だけ扱う（anon鍵では直接読めない）。
--   ・cast_name / course / visit_date / customer_no は発行時にコピーして持つ。
--     予約が後から削除・変更されてもアンケート履歴が壊れないようにするため（JOINしない）。
--   ・回答の重複は「submitted_at IS NULL のときだけ UPDATE する」で防ぐ。
--
-- 既存データ・既存挙動には影響しない（新規テーブル＋NULL許容の追加カラムのみ）。
--
-- 適用先: KYOUKANO本番(qgcgkrcrfzonmmygcdju) / SaaS開発(fewuonnrgqnxtopkjudt)

-- ------------------------------------------------------------
-- 1. surveys テーブル
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS surveys (
  id             bigserial PRIMARY KEY,
  store_id       uuid REFERENCES stores(id),
  reservation_id bigint,        -- reservations.id（外部キーは張らない。予約削除で履歴を失わないため）
  cast_id        integer,
  cast_name      text,          -- 発行時点のセラピスト名
  store_name     text,          -- 発行時点の店名（お客様の画面に表示）
  course         text,
  customer_no    integer,
  visit_date     date,          -- 来店日（シフト日）
  token          uuid NOT NULL, -- URLに載せる鍵
  ratings        jsonb,         -- {"service":5,"skill":4,"clean":5,"total":5}（1〜5の整数のみ）
  submitted_at   timestamptz,   -- NULL = 未回答
  created_at     timestamptz DEFAULT now()
);

-- token はグローバルに一意（別店舗含め衝突しない）
CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_token ON surveys(token);
-- 予約1件につきアンケートは1枚（ボタンを2回押しても増えない）
CREATE UNIQUE INDEX IF NOT EXISTS idx_surveys_reservation ON surveys(reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_store_id ON surveys(store_id);
CREATE INDEX IF NOT EXISTS idx_surveys_submitted_at ON surveys(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_cast_id ON surveys(cast_id);

-- ------------------------------------------------------------
-- 2. RLS（DBが行ごとにアクセス可否を判定する仕組み）
--    005_rls_store_isolation.sql が既存テーブルに付けたポリシーと同じ形にそろえる。
--      anon（PINアプリ）        → store_id IS NULL の行のみ
--      authenticated（SaaS/PIN） → 自店舗の store_id の行のみ
--      Edge Function            → service_role のため RLS をバイパス
-- ------------------------------------------------------------
ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "rls_select_surveys" ON surveys FOR SELECT USING (check_store_access(store_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "rls_insert_surveys" ON surveys FOR INSERT WITH CHECK (check_store_access(store_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "rls_update_surveys" ON surveys FOR UPDATE
    USING (check_store_access(store_id)) WITH CHECK (check_store_access(store_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "rls_delete_surveys" ON surveys FOR DELETE USING (check_store_access(store_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- テーブル権限（RLSの手前の関門。sos_alerts と同じ運用）
GRANT SELECT, INSERT, UPDATE, DELETE ON surveys TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE surveys_id_seq TO anon, authenticated;

COMMENT ON TABLE surveys IS '施術後アンケート。オーナーのみ閲覧（セラピストには見せない）';

-- ------------------------------------------------------------
-- 3. アンケートURLと一緒にコピーされる文章
-- ------------------------------------------------------------
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS survey_copy_message text;
