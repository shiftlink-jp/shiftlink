-- cast_fees に雑費自動計算の「本数の区切り」カラムを追加
-- 雑費は施術本数に応じて3段階（misc_0 / misc_1 / misc_3）で自動計算される。
-- これまで区切りは 1本以下 / 2本 / 3本以上 で固定だったが、店舗ごとに変更できるようにする。
-- misc_c0: 第1段（この本数まで → misc_0）。デフォルト1
-- misc_c1: 第2段の表示用本数（中間 → misc_1）。デフォルト2
-- misc_c2: 第3段（この本数以上 → misc_3）。デフォルト3
-- 計算ロジック: count<=misc_c0→misc_0 / count>=misc_c2→misc_3 / それ以外→misc_1
-- 未設定（NULL）の既存データは従来通り 1/2/3 にフォールバックするため挙動は不変。
ALTER TABLE cast_fees
  ADD COLUMN IF NOT EXISTS misc_c0 integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS misc_c1 integer DEFAULT 2,
  ADD COLUMN IF NOT EXISTS misc_c2 integer DEFAULT 3;
