# 今夜のカットオーバー実行台本（Phase A）— 2026-06-12 深夜2時（閉店後）

対象: KYOUKANO本番 `qgcgkrcrfzonmmygcdju`
範囲: **Phase A のみ**（新ログイン稼働＋動作確認。anonは開けたまま＝安全網）。
Phase B（anon遮断＋平文PIN消去012）は後日、1営業日の観察後に別途。

分担: **SQLはユーザー**（Supabase SQL Editor）／**CLI・gitはClaude**／**実機確認はユーザー**。
原則: 各ステップで結果を確認してから次へ。異常時は即ロールバック（手順末尾）。

> 重要: 今夜は破壊的変更なし（平文PINは消さない＝012はやらない）。万一おかしくても
> anonが開いているのでアプリは動き続ける。012（不可逆）はPhase Bで、DBバックアップ後に行う。

---

## 0. 開始前の準備（ユーザー）
- [ ] KYOUKANOが閉店・無人であること（営業時間外）。
- [ ] Supabase ダッシュボード → 本番 `qgcgkrcrfzonmmygcdju` の SQL Editor を開く。
- [ ] 動作確認用に「オーナーPIN」と「キャスト1名のPIN」を手元に（今と同じPINでログインできる）。
- [ ] スマホ（実機）でKYOUKANOアプリを開ける状態に。

## 0.5 PIN平文バックアップ（ユーザー・SQL／保険・推奨）
今夜は平文を消さないが、Phase Bに備えて保険として取得しておくと安心。
```sql
CREATE TABLE IF NOT EXISTS _pin_backup_20260613 AS
SELECT 'cast' AS kind, id::text AS ref, store_id, pin::text AS pin_plain FROM casts WHERE pin IS NOT NULL
UNION ALL
SELECT 'owner' AS kind, store_id::text AS ref, store_id, owner_pin::text FROM store_settings WHERE owner_pin IS NOT NULL;
SELECT kind, count(*) FROM _pin_backup_20260613 GROUP BY kind;  -- cast/owner の件数を確認
```

---

## 1. Edge Function を本番デプロイ（Claude）
新ログインに必要な関数を本番へ。※send-push厳格版はPhase B（今夜は旧版のまま＝通知は従来どおり動く）。
staging（最新の関数コードを含む）をチェックアウトした状態でデプロイする。
```
# PIN認証(カットオーバー)用
supabase functions deploy pin-login --project-ref qgcgkrcrfzonmmygcdju
supabase functions deploy set-pin   --project-ref qgcgkrcrfzonmmygcdju
# SaaS公開URL(shiftlink-app.jp)対応：CORS許可追加(commit 939da9e)。X集客の申込導線用。
supabase functions deploy create-trial-subscription --project-ref qgcgkrcrfzonmmygcdju
supabase functions deploy stripe-checkout           --project-ref qgcgkrcrfzonmmygcdju
supabase functions deploy stripe-portal             --project-ref qgcgkrcrfzonmmygcdju
```
- pin-login: #5（200件上限）/#6（同時ログイン競合）修正版に更新。
- set-pin: 新規（PIN変更/新規キャストPINをauth_pins経由で安全に設定）。
- create-trial-subscription / stripe-checkout / stripe-portal: ALLOWED_ORIGINS に shiftlink-app.jp 追加。
  これでLP(shiftlink-app.jp)→申込/トライアルがCORSで止まらない。※Stripeは現状テストモード（本番課金は別途切替）。
- この時点ではまだ本番クライアント(main)はPIN認証OFFなので、pin-login/set-pinは誰も呼ばない＝無影響。
  SaaS3関数もCORS許可を足すだけなので既存挙動に影響なし。

## 2. クライアントを本番反映（Claude・ユーザーの明示指示で実行）
ユーザーが「mainにマージしてpushして」と言ったらClaudeが実行:
```
git checkout main && git merge staging && git push origin main
```
→ Vercel自動デプロイ。KYOUKANOがPIN認証モードに切替（#2/#3/#4/#8のクライアント側も反映、SW v16）。
- ※`staging`の全コミット（LP修正等も含む）がmainへ入る。セキュリティ修正＋カットオーバー用変更が主。

## 3. 本番ログイン動作確認（ユーザー・実機）
- [ ] アプリを**完全に閉じて開き直す**（PWAは開きっぱなしだと旧コードのまま。開き直せば新コード）。
- [ ] **オーナーPIN**（今と同じ）でログイン → 本日/予約/顧客/売上/ルームが正常表示。
- [ ] **キャストPIN**（今と同じ）で1名ログイン → キャスト画面が正常。
- [ ] **通知**: 入室/退室など操作 → オーナー・キャストに通知が届く（従来どおり）。
- ❗ここで異常があれば即「ロールバック」（末尾）。anonが開いているのでデータは消えない。

## 4. 残NULLスイープ（ユーザー・SQL）
バックフィル(6/11)以降〜今夜までに作られた行のstore_id=NULLを回収（Phase Bのanon遮断に備える）。
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
（テーブルが存在しない等のエラーが出たら、その行だけ飛ばして残りを実行→Claudeに報告）

## 5. スイープ検証（ユーザー・SQL）— 全部 0 ならOK
```sql
SELECT 'casts' t, count(*) FILTER (WHERE store_id IS NULL) n FROM casts
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

---

## Phase A 完了
- ここで今夜は終了。**anonは開けたまま**＝何かあってもアプリは動く。
- 1営業日、普段どおりログイン・予約・委託金入力・売上確認・通知ができるかを観察。
- 問題なければ後日オフタイムに **Phase B**（docs/cutover-runbook-20260611.md の B-1〜）:
  B-1残NULL確認 → B-2 send-push厳格版deploy(#2) → B-3 anon遮断 → B-4検証 →（別途）012平文消去。
  ※012の前に必ずDBバックアップ。今夜の `_pin_backup_20260613` も保険として残す。

## ロールバック（異常時・今夜）
ログイン/通知/表示が壊れたら、Claudeがmainを元に戻す:
```
git checkout main && git revert -m 1 HEAD && git push origin main
```
→ Vercelが旧クライアント（anon方式）を再デプロイ＝Phase A前に復帰。anonは開いているのでデータは見える。
（デプロイ済みのpin-login/set-pinは旧クライアントからは呼ばれないので残しても無害）

## 当日メモ
- send-push厳格版(#2)は今夜デプロイしない（旧版のまま＝通知は従来動作）。Phase BのB-2で実施。
- PINは今と同じものでログインできる（011で移行済・照合確認済）。番号は変わらない。
- 期間中（〜Phase Bの012完了まで）PIN変更・新規キャストPIN設定はしない方針（ユーザー合意済）。
