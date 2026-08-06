# Phase1 バックフィル実行手順書（Stage 0 + Stage 1）

作成: 2026-06-10 / 関連: [security-auth-migration-plan.md](./security-auth-migration-plan.md)

## この手順の安全性について

- **本番アプリの挙動は実行前後で一切変わりません**（anonアクセスは継続、見た目も同じ）。
- 目的は「既存データ（store_id=NULL）にKYOUKANOのstore_idラベルを貼る」ことだけ。
- **Stage3（anon遮断）はこの手順には含まれません**。Stage2（認証モード本番化＋E2E検証）が
  完了するまでStage3には進まないこと。
- **順序厳守**: Stage1-① (RLS互換拡張) を必ず先に実行 → その後 Stage1-② (テーブル別バックフィル)。
  逆順だと、バックフィル済みテーブルが一時的にanonから見えなくなる（ロックアウト）。

## 実施タイミング

- Stage 0: いつでも可（既存データに触れない単純INSERT）。
- Stage 1: 営業時間外推奨。理由: バックフィル中に新規予約等が`store_id=NULL`でINSERTされると
  その行だけ取りこぼす（後述のフォローアップで対応可能だが、深夜の方が単純）。

---

## Stage 0: KYOUKANO の store_id を発行

```sql
INSERT INTO stores (name, slug, owner_email, plan, subscription_status, trial_ends_at)
VALUES ('KYOUKANO', 'kyoukano', NULL, 'internal', 'active', NULL)
RETURNING id;
```

- `owner_email` は後で `UPDATE stores SET owner_email='...' WHERE id='<上記id>'` で設定可。
- `plan='internal'` / `subscription_status='active'` / `trial_ends_at=NULL` とし、
  Stripe関連のtrial期限切れ判定の対象外にしておく。
- **返ってきた `id`（UUID）を以下すべてのSQLの `<KYOUKANO_UUID>` に置き換えて使用する。**

ロールバック（Stage1未実施なら無条件で安全）:
```sql
DELETE FROM stores WHERE id = '<KYOUKANO_UUID>';
```

---

## Stage 1-①: RLS互換拡張（先に実行・必須）

```sql
CREATE OR REPLACE FUNCTION check_store_access(row_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN row_store_id IS NULL OR row_store_id = '<KYOUKANO_UUID>'::uuid
    ELSE row_store_id = get_my_store_id()
  END;
$$;
```

確認:
```sql
-- 現在のKYOUKANOデータ(NULL)がまだ見える、かつ今後UUID化しても見え続ける設計であることの確認
SELECT check_store_access(NULL), check_store_access('<KYOUKANO_UUID>'::uuid);
-- → 両方 true ならOK（auth.uid() IS NULLのセッションで実行した場合）
```

ロールバック（005の元定義に戻す）:
```sql
CREATE OR REPLACE FUNCTION check_store_access(row_store_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN row_store_id IS NULL
    ELSE row_store_id = get_my_store_id()
  END;
$$;
```

---

## Stage 1-②: テーブル別バックフィル（①の後、1テーブルずつ実行）

対象16テーブル（[001_saas_multi_tenant.sql](../supabase/migrations/001_saas_multi_tenant.sql) +
[002_rooms_and_seed.sql](../supabase/migrations/002_rooms_and_seed.sql) でstore_id追加済み）:

```
casts, shifts, reservations, customers, customer_visits, works, courses, options,
cast_fees, cast_discounts, passkeys, push_subscriptions, store_settings, daily_notes,
monthly_sales, rooms
```

各テーブルにつき「件数確認 → UPDATE → 件数確認」を1セットで実行する。
以下は `casts` の例。**他15テーブルもテーブル名を置き換えて同じパターンで実行**:

```sql
-- ① 更新前の件数確認（この数を控えておく）
SELECT count(*) FROM casts WHERE store_id IS NULL;

-- ② バックフィル
UPDATE casts SET store_id = '<KYOUKANO_UUID>'::uuid WHERE store_id IS NULL;

-- ③ 確認: NULLが0件、UUID件数が①と一致すること
SELECT
  (SELECT count(*) FROM casts WHERE store_id IS NULL) AS remaining_null,
  (SELECT count(*) FROM casts WHERE store_id = '<KYOUKANO_UUID>'::uuid) AS now_kyoukano;
```

**③で `remaining_null` が0でない場合は、そのテーブルだけ深夜中も新規INSERTが
発生した可能性がある。** 一旦そのまま進めてOK（compat shimによりNULLのままでも
anonから見え続けるため）。翌朝以降にもう一度同じUPDATEを流せば回収できる。

### 全テーブル実行後の最終確認

```sql
SELECT 'casts' t, count(*) FROM casts WHERE store_id IS NULL
UNION ALL SELECT 'shifts', count(*) FROM shifts WHERE store_id IS NULL
UNION ALL SELECT 'reservations', count(*) FROM reservations WHERE store_id IS NULL
UNION ALL SELECT 'customers', count(*) FROM customers WHERE store_id IS NULL
UNION ALL SELECT 'customer_visits', count(*) FROM customer_visits WHERE store_id IS NULL
UNION ALL SELECT 'works', count(*) FROM works WHERE store_id IS NULL
UNION ALL SELECT 'courses', count(*) FROM courses WHERE store_id IS NULL
UNION ALL SELECT 'options', count(*) FROM options WHERE store_id IS NULL
UNION ALL SELECT 'cast_fees', count(*) FROM cast_fees WHERE store_id IS NULL
UNION ALL SELECT 'cast_discounts', count(*) FROM cast_discounts WHERE store_id IS NULL
UNION ALL SELECT 'passkeys', count(*) FROM passkeys WHERE store_id IS NULL
UNION ALL SELECT 'push_subscriptions', count(*) FROM push_subscriptions WHERE store_id IS NULL
UNION ALL SELECT 'store_settings', count(*) FROM store_settings WHERE store_id IS NULL
UNION ALL SELECT 'daily_notes', count(*) FROM daily_notes WHERE store_id IS NULL
UNION ALL SELECT 'monthly_sales', count(*) FROM monthly_sales WHERE store_id IS NULL
UNION ALL SELECT 'rooms', count(*) FROM rooms WHERE store_id IS NULL
ORDER BY 1;
```

全行が0であれば完了。0でない行が残っても**異常ではない**（compat shimが効いている間は
anonから見え続ける）。後日まとめて回収すればよい。

### ロールバック（個別テーブル）

```sql
UPDATE <table> SET store_id = NULL WHERE store_id = '<KYOUKANO_UUID>'::uuid;
```

このUUIDはStage0で新規発行した専用IDのため、他のSaaS店舗データと混在する心配はない。
全テーブルに対して実行すれば、Stage1全体を完全に元に戻せる。Stage1-①のロールバックも
合わせて実行すれば、実行前の状態に完全復帰する。

---

## 実行後にやること（本番影響なし、すぐ確認可）

```sql
-- 本番アプリ(anon)から見たときのKYOUKANOデータ件数が、バックフィル前と一致するか
SELECT count(*) FROM reservations; -- anon roleで実行（RLS適用）
```

## Stage1完了後の次のステップ

Stage1完了は「データにラベルを貼った」だけで、**Phase2（認証モード本番化）・
Phase3（anon遮断）には進まない**。次は:

1. テスト店舗でPhase2 E2E予行（[phase2_認証モード_e2eチェックリスト_20260610.md](../テスト部/成果物/phase2_認証モード_e2eチェックリスト_20260610.md)）
2. レガシー3箇所修正（index.html:1774, 5879, 2566 を `currentStoreId` 基準へ）
3. PIN認証モードを本番デフォルト化 → デプロイ → 全機能再検証
4. 上記すべて完了後、Stage3（anon遮断）をロールバックSQL常備で実施

---

## 実施記録（2026-06-11 実施・完了）

本番プロジェクト `qgcgkrcrfzonmmygcdju` のSupabase SQL Editorでユーザーが実行（Opusが手順生成・結果検証）。

- **KYOUKANO store_id（UUID）**: `4cb3383a-31e5-408a-9f75-60a25943ac4d`
- **Stage 0**: stores に KYOUKANO 行を発行（`plan='internal'`, `subscription_status='active'`, `trial_ends_at=NULL`）。
- **Stage 1-①**: `check_store_access` を互換拡張（anon分岐に `OR row_store_id = '4cb3383a-…'` 追加）。
  確認クエリ `sees_null=true / sees_kyoukano=true` を確認。
- **Stage 1-②**: 16テーブルを1トランザクション（BEGIN…COMMIT）で `store_id IS NULL → KYOUKANO_UUID` に更新。
  検証で **remaining_null 全テーブル0**、now_kyoukano が事前診断のNULL件数と完全一致。
  バックフィル総数 **2,888件**（内訳: reservations 769 / customer_visits 735 / customers 413 /
  works 409 / shifts 393 / daily_notes 69 / casts 25 / cast_fees 24 / passkeys 19 /
  push_subscriptions 12 / courses 6 / rooms 4 / cast_discounts 4 / options 3 / monthly_sales 2 /
  store_settings 1）。テスト店舗A/Bのデータ（store_id IS NOT NULL 計22件）は対象外で不変。
- **最終確認**: SQL Editorで `SET LOCAL ROLE anon` に切り替えてRLS適用下の件数を確認
  → reservations 769 / customers 413 / works 409 / casts 25 が一致。
  **バックフィル後も本番アプリ（anon）が全データを正常に閲覧できることを実証。Phase1完全成功。**

### 注意（Phase1完了後の中間状態）
- KYOUKANO本番アプリ（`?pinauth`なし=anon）は依然 store_id=NULL で新規INSERTを続ける。
  互換シムで NULL も可視のため壊れないが、新規行はKYOUKANO_UUIDが付かない。
- **Stage3（anon遮断）に進む直前に、もう一度同じバックフィルUPDATEで残NULLを回収**してから
  互換シムのanon分岐を false 化すること（順序: 次ステップ3でPIN認証本番デフォルト化 →
  最終スイープ → Stage3）。
