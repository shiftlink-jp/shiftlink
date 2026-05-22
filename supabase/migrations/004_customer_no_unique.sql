-- 顧客番号の採番競合対策
-- 同一店舗内で customer_no の重複を防ぐUNIQUE制約を追加
-- これによりクライアント側のリトライロジックが正しく機能する

-- 既存の重複データをチェック（参考、本番投入前に確認）
-- SELECT store_id, customer_no, COUNT(*) FROM customers GROUP BY store_id, customer_no HAVING COUNT(*) > 1;

-- store_id がNULLの場合（非SaaSモード/単一店舗）でも一意性を担保したいので、
-- store_id を coalesce で扱う部分インデックスは作らず、NULL を含む合成キーで一意化する。
-- PostgreSQLでは NULL は UNIQUE 制約で複数許容されるため、
-- NULLS NOT DISTINCT (PG15+) または「coalesce式インデックス」を使う。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='customers' AND indexname='customers_store_no_unique'
  ) THEN
    -- coalesce式インデックスで store_id=NULL も一意化対象に含める
    EXECUTE 'CREATE UNIQUE INDEX customers_store_no_unique ON customers ((COALESCE(store_id::text, ''_default'')), customer_no)';
  END IF;
END $$;
