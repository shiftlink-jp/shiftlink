-- cast_feesテーブルにJSON拡張カラムを追加（既存DB適用済みの場合はスキップ）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cast_fees' AND column_name='extra_course_backs'
  ) THEN
    ALTER TABLE cast_fees ADD COLUMN extra_course_backs jsonb DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cast_fees' AND column_name='extra_op_backs'
  ) THEN
    ALTER TABLE cast_fees ADD COLUMN extra_op_backs jsonb DEFAULT '{}';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cast_fees' AND column_name='extra_trial_op_backs'
  ) THEN
    ALTER TABLE cast_fees ADD COLUMN extra_trial_op_backs jsonb DEFAULT '{}';
  END IF;
END $$;
