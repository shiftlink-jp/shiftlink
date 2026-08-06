-- 033_lock_homepage_shifts_write.sql
--
-- homepage_shifts の書き込みが店舗をまたげる状態だった。
--   homepage_shifts_read  : roles={anon,authenticated} SELECT using=true   ← 公開読み取り（意図どおり）
--   homepage_shifts_write : roles={authenticated}      ALL    using=true   ← 🚨 これ
-- ＝ ログインしてさえいれば、どの店舗のホームページ用シフトでも書き換えられる。
-- 1店舗のうちは無害だが、2店舗目の契約と同時に実害になる。
--
-- このテーブルは「ホームページ同期専用」（docs/multi-tenant-design.md:76）で
-- store_id 列を持たない。列を足すと外部の同期システム側が壊れうるため、
-- cast_id → casts.store_id を辿って店舗を判定する。列は一切変更しない。
--
-- 適用前の実測（2026-08-07・本番）:
--   - 行数 45
--   - 最終 created_at / updated_at = 2026-05-25 ＝ 外部の同期は2ヶ月半停止している
--   - cast_id が casts に無い「迷子の行」= 0件（FOR ALL の USING は DELETE にも効くため、
--     迷子があると deleteCast の後始末が失敗する。0件を確認してから適用した）
--
-- ⚠️ FOR ALL の USING は DELETE にも適用される。deleteCast（index.html:10938）が
--    homepage_shifts を消せる必要があるので、USING と WITH CHECK を必ず両方置くこと。

DROP POLICY IF EXISTS homepage_shifts_write ON homepage_shifts;

CREATE POLICY homepage_shifts_write ON homepage_shifts FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM casts c
            WHERE c.id = homepage_shifts.cast_id
              AND check_store_access(c.store_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM casts c
            WHERE c.id = homepage_shifts.cast_id
              AND check_store_access(c.store_id))
  );

-- 読み取り（homepage_shifts_read）は変更しない。ホームページが公開表示に使っているため。

-- ロールバック（ホームページのシフト更新が止まったら、まずこれを試す）:
--   DROP POLICY IF EXISTS homepage_shifts_write ON homepage_shifts;
--   CREATE POLICY homepage_shifts_write ON homepage_shifts FOR ALL TO authenticated
--     USING (true) WITH CHECK (true);
