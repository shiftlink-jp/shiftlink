# KYOUKANO 本番カットオーバー実行手順書（2026-06-11 作成）

Phase1バックフィル完了後、KYOUKANO本番を「anon方式」→「PIN認証＋anon遮断」へ切り替える手順。
SQLはユーザーがSupabase SQL Editor（本番 `qgcgkrcrfzonmmygcdju`）で実行、gitはClaudeが実行。

- **KYOUKANO store_id** = `4cb3383a-31e5-408a-9f75-60a25943ac4d`
- 前提【完了】: Phase1バックフィル(2888件)、rooms回帰修正(6fca2e6)、Option B(c6804e5)、
  ステップ2コード(a7fe2aa, staging保留)、?pinauth=KYOUKANO_UUIDでの認証経路 実データ予行OK。

## 安全設計: 2段階に分ける
- **Phase A**: ステップ2デプロイ＋残NULLスイープ。**anonはまだ開けたまま（安全網）**。
  PIN認証で本番が正常稼働することを1営業日観察する。
- **Phase B**: 観察で問題なければ、anon遮断（セキュリティ穴の根治）。ロールバックSQL常備。

理由: ステップ2(ログイン方式の本番切替)は大きい変更。万一の不具合時もanonが開いていれば
アプリは動き続ける（compat shim）。anon遮断は「PIN認証が確実に安定」を確認してから。

---

## Phase A（オフタイム・営業時間外）

### A-1. ステップ2を本番デプロイ（Claude実行）
staging→main マージ＆push（KYOUKANOがPIN認証モードに切替）。ユーザーが「mainにマージして
pushして」と明示指示 → Claudeが `git checkout main && git merge staging && git push origin main`。
Vercel自動デプロイ。

### A-2. 本番ログイン検証（ユーザー・実機）
- 本番アプリを**完全に閉じて開き直す**（PWAは開きっぱなしのタブだと旧コードのまま。
  index.htmlはno-storeなので開き直せば新コード）。
- オーナーPINでログイン → 本日/予約/顧客/売上/ルームが正常表示。
- キャストPINで1名ログイン → キャスト画面正常。
- ※ここで異常があれば A-1 をロールバック（`git revert` でステップ2を戻して再デプロイ）。

### A-3. 残NULL最終スイープ（ユーザー・SQL）
ステップ2デプロイ後は新規行にKYOUKANO_UUIDが付くが、本日バックフィル(15:41)以降〜デプロイ
までに作られた行はstore_id=NULLで残る。これを回収（compat shimで見えてはいるが、anon遮断で
消えるため必ず実施）。

```sql
BEGIN;
UPDATE casts              SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE shifts             SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE reservations       SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE customers          SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE customer_visits    SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE works              SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE courses            SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE options            SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE cast_fees          SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE cast_discounts     SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE passkeys           SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE push_subscriptions SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE store_settings     SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE daily_notes        SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE monthly_sales      SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
UPDATE rooms              SET store_id='4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid WHERE store_id IS NULL;
COMMIT;
```

### A-4. スイープ検証（ユーザー・SQL）
全テーブル remaining_null=0 を確認（0なら完了）。
```sql
SELECT 'casts' t, count(*) FILTER (WHERE store_id IS NULL) remaining_null FROM casts
UNION ALL SELECT 'shifts', count(*) FILTER (WHERE store_id IS NULL) FROM shifts
UNION ALL SELECT 'reservations', count(*) FILTER (WHERE store_id IS NULL) FROM reservations
UNION ALL SELECT 'customers', count(*) FILTER (WHERE store_id IS NULL) FROM customers
UNION ALL SELECT 'customer_visits', count(*) FILTER (WHERE store_id IS NULL) FROM customer_visits
UNION ALL SELECT 'works', count(*) FILTER (WHERE store_id IS NULL) FROM works
UNION ALL SELECT 'courses', count(*) FILTER (WHERE store_id IS NULL) FROM courses
UNION ALL SELECT 'options', count(*) FILTER (WHERE store_id IS NULL) FROM options
UNION ALL SELECT 'cast_fees', count(*) FILTER (WHERE store_id IS NULL) FROM cast_fees
UNION ALL SELECT 'cast_discounts', count(*) FILTER (WHERE store_id IS NULL) FROM cast_discounts
UNION ALL SELECT 'passkeys', count(*) FILTER (WHERE store_id IS NULL) FROM passkeys
UNION ALL SELECT 'push_subscriptions', count(*) FILTER (WHERE store_id IS NULL) FROM push_subscriptions
UNION ALL SELECT 'store_settings', count(*) FILTER (WHERE store_id IS NULL) FROM store_settings
UNION ALL SELECT 'daily_notes', count(*) FILTER (WHERE store_id IS NULL) FROM daily_notes
UNION ALL SELECT 'monthly_sales', count(*) FILTER (WHERE store_id IS NULL) FROM monthly_sales
UNION ALL SELECT 'rooms', count(*) FILTER (WHERE store_id IS NULL) FROM rooms
ORDER BY t;
```

**Phase A 完了。ここで一旦終了し、1営業日 PIN認証での通常稼働を観察する。**

---

## 観察期間（1営業日）
- オーナー・キャストが普段どおりログイン・予約・委託金入力・売上確認できるか。
- error_logs に認証/RLS起因のエラーが出ていないか（任意でSELECT確認）。
- 問題があれば Phase B に進まず、ステップ2のロールバック（git revert）を検討。

---

## Phase B（観察OK後・オフタイム）

### B-1. 残NULL最終確認（ユーザー・SQL）
A-4 の検証SQLを再実行 → 全0 を確認（PIN認証稼働中なので新規NULLは出ないはず。
万一あれば A-3 のUPDATEを再実行してから次へ）。

### B-2. send-push 厳格版デプロイ（監査#2 対策・Claude実行）
公開anon鍵だけで誰でも偽Pushを送れる #2 を塞ぐ。Phase A でクライアントは既に
ログインセッションを send-push へ送っている（`sendPushNotification` 改修済み）ため、
ここで関数を厳格版に差し替えても通知は壊れない。
```
supabase functions deploy send-push --project-ref qgcgkrcrfzonmmygcdju
```
- 厳格版は「内部シークレット or service_role」以外は `admin.auth.getUser` で本物のセッションを必須にし、
  `store_members` で自店のみ送信可に制限する（anon鍵は user が取れず 401）。
- **検証（ユーザー・実機）**: デプロイ後、本番アプリ（PIN認証ログイン状態）で
  入室/退室/予約/シフト承認などを操作 → オーナー・キャスト双方に通知が**従来どおり届く**こと。
- **#2が塞がれた確認（任意・コンソール/curl）**: anon鍵だけで送ると 401 になること
  （`curl -X POST .../functions/v1/send-push -H "Authorization: Bearer <anon鍵>" -d '{...}'` → 401）。
- 異常時ロールバック: 旧版 send-push に戻す（`git revert` 後に再 deploy、または直前版を deploy）。
  旧版に戻せば anon鍵でも送信できる従来挙動に復帰（#2は再び開くが通知は復旧）。

### B-3. anon遮断（ユーザー・SQL）
```sql
CREATE OR REPLACE FUNCTION check_store_access(row_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false               -- anon遮断: anonは16テーブルに一切アクセス不可
    ELSE row_store_id = get_my_store_id()
  END;
$$;
```

### B-4. 検証（ユーザー）
- 本番アプリを開き直し → PIN認証でログイン → 全データ正常表示（認証セッションで動作）。
- anon遮断確認（SQL）: 下記が **0件** になればanonから読めない＝遮断成功。
```sql
BEGIN;
SET LOCAL ROLE anon;
SELECT count(*) AS anon_can_read FROM reservations;  -- 0 が期待値
COMMIT;
```

### B-5. ロールバック（異常時のみ・compat shimへ戻す）
anon遮断後にアプリが壊れた場合、即座に下記でanon可視に戻す（Phase A状態へ復帰）。
```sql
CREATE OR REPLACE FUNCTION check_store_access(row_store_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN row_store_id IS NULL OR row_store_id = '4cb3383a-31e5-408a-9f75-60a25943ac4d'::uuid
    ELSE row_store_id = get_my_store_id()
  END;
$$;
```

---

## 完了後
- セキュリティ監査 CRITICAL #1（anon鍵で全PII CRUD）が根治。
- セキュリティ監査 CRITICAL #2（公開anon鍵で誰でも偽Pushを送れる）が根治（B-2）。
- 今後の他店貸出（SaaS版 app.shiftlink.jp）も、anonに頼らない前提が整う。
- ログイン前のcredential取得・passkeyは Option B で無効化済み。生体認証UXを戻したい場合は
  別途 passkey-login Edge Function を新設（docs/phase2-3-cutover-audit-20260611.md 参照）。
