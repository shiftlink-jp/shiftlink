# Supabase 運用スクリプト

ここには本番DBに手動で適用する運用スクリプトを置く。
migration（自動適用）ではなく、運用時に判断して実行するもの。

## ファイル一覧

| ファイル | 用途 |
|---|---|
| `verify_rls_prerequisites.sql` | RLS適用前の事前確認（読み取り専用） |
| `rollback_rls.sql` | 緊急ロールバック（RLSを全テーブルで無効化） |

## RLS適用の手順

### 1. 事前確認
Supabase Dashboard → SQL Editor で `verify_rls_prerequisites.sql` を実行し、以下を確認：

- `stores_exists`, `store_members_exists`, `get_my_store_id_exists` が全て `true`
- すべてのテーブルで `store_id_column` が `OK`
- 既存データの `null_rows` は適切な件数があり、`saas_rows` は0または想定通り
- 既存のRLSが有効になっているテーブルがない（`rls_enabled=true`は `stores`, `store_members` のみOK）

### 2. RLS適用
Supabase Dashboard → SQL Editor で `supabase/migrations/005_rls_store_isolation.sql` の全内容をコピー＆実行。

### 3. 動作確認（必須）
本番アプリで以下を即座にテスト：
- [ ] オーナーPINログイン
- [ ] キャストPINログイン
- [ ] 本日ページ表示
- [ ] シフト表示
- [ ] 顧客情報表示
- [ ] 委託金シート開く

### 4. 問題があったらロールバック
`rollback_rls.sql` を Supabase Dashboard → SQL Editor で実行。
RLSが無効化されてアプリが元に戻る（ポリシー定義は残るので再適用が容易）。
