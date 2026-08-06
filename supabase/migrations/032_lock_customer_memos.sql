-- 032_lock_customer_memos.sql
--
-- customer_memos に「anonが全操作を無条件で許可される」ポリシーが残っていた。
--   allow_all_customer_memos : roles={anon} cmd=ALL using=true
--   read/update/delete memos : roles={public} using=true
-- ＝ 公開されているanon鍵さえあれば、誰でも全件の読み書き削除ができる状態。
--
-- 経緯: 008_drop_legacy_policies.sql に
--   「customer_memos: shop_idカラムのため対象外（既存ポリシーを維持）」
-- と書かれている。store_id ではなく shop_id を持つ旧設計のテーブルで、
-- 一括整理の対象から外れたまま、緩いポリシーだけが残った。
--
-- 現状（2026-08-06 実測）:
--   - 行数 0 件（実データは無い＝いま漏れているものは無い）
--   - index.html からの参照 0 件（アプリは使っていない）
-- → いま塞いでも影響が出ようがない。ただし放置すると、この表を使い始めた瞬間に
--   顧客メモが全世界に公開される。先に塞ぐ。
--
-- 方針: ポリシーを全て落とす。RLS有効 かつ ポリシー0本 = 誰も読み書きできない。
--       Edge Function（service_role）は RLS を迂回するので、将来サーバー経由で
--       使う分には支障がない。使う時が来たら store 単位のポリシーを足す。

DROP POLICY IF EXISTS "allow_all_customer_memos" ON customer_memos;
DROP POLICY IF EXISTS "read memos"   ON customer_memos;
DROP POLICY IF EXISTS "insert memos" ON customer_memos;
DROP POLICY IF EXISTS "update memos" ON customer_memos;
DROP POLICY IF EXISTS "delete memos" ON customer_memos;

-- 念のためRLS自体が有効であることを保証する（既に有効なはずだが冪等に）
ALTER TABLE customer_memos ENABLE ROW LEVEL SECURITY;

-- 確認用:
--   select policyname from pg_policies where tablename='customer_memos';  → 0件になる
--   匿名で読めないこと:
--   curl "$URL/rest/v1/customer_memos?select=id&limit=1" -H "apikey: $ANON" → []
