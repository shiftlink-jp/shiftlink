# 予約確認URL機能 — 本番反映手順書（素人向け）

この手順書は、新機能「お客様用 予約確認URL」を **KYOUKANO本番** で使えるようにするための、
ブラウザ（Supabaseの管理画面）だけで完結する作業手順です。コマンド操作は不要です。

> 対象プロジェクト: **KYOUKANO本番**（プロジェクトID `qgcgkrcrfzonmmygcdju`）
> この2つの作業は「追加のみ・既存を壊さない」設計です。作業しても、今のお客さん・お店の
> データや画面には一切影響しません（新ボタンはmainマージ後まで本番に出ないため、機能は眠ったまま）。

---

## 作業は全部で3ステップ

- **ステップ1**: データベースに項目を追加（SQLを貼って実行するだけ）
- **ステップ2**: 窓口プログラム（Edge Function）を1つ設置
- **ステップ3**: 動作確認 → 問題なければ本番公開（Claudeが担当）

所要時間の目安: 10〜15分。

---

## ステップ1: データベースに項目を追加

「マイグレーション」とは、データベースの入れ物（表）に新しい項目（列）を足す作業のことです。

1. ブラウザで https://supabase.com/dashboard を開き、ログイン
2. プロジェクト一覧から **KYOUKANO本番**（`qgcgkrcrfzonmmygcdju`）を選ぶ
   - ※ SaaS開発用（`fewuonnrgqnxtopkjudt`）ではありません。間違えないように注意
3. 左メニューの **SQL Editor**（紙にペンのアイコン）をクリック
4. **「+ New query」** を押して空の入力欄を出す
5. 下の枠の中身を **すべてコピー** して貼り付ける

```sql
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS public_token uuid;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS public_snapshot jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_public_token
  ON reservations(public_token) WHERE public_token IS NOT NULL;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS address text;
```

6. 右下の **「Run」**（または Cmd/Ctrl + Enter）を押す
7. 下に **「Success. No rows returned」** と出れば成功です

> もし2回実行しても大丈夫です（`IF NOT EXISTS` なので、すでに追加済みなら何もしません）。

---

## ステップ2: 窓口プログラム（Edge Function）を設置

「Edge Function」とは、お客さんがURLを開いたときに、鍵を照合して予約1件だけを
安全に返す小さなプログラムです。お客さんに生のデータを見せないための"受付窓口"です。

1. 同じKYOUKANO本番プロジェクトで、左メニューの **Edge Functions** をクリック
2. **「Deploy a new function」**（または「Create a new function」）を押す
3. 関数名（Function name）に **`get-reservation-public`** と正確に入力
   - ※ ハイフンも含めてこの名前でないと動きません
4. **「Verify JWT with legacy secret」** のような**チェックをオフ（無効）** にする
   - これは「ログインしていない人（＝お客さん）でも開けるようにする」ための設定です
   - 場所は関数作成画面の設定、または作成後の Function の Settings にあります
5. コード入力欄に、リポジトリの
   `supabase/functions/get-reservation-public/index.ts` の中身を**すべて貼り付ける**
   （このファイルはClaudeが用意済みです。中身をコピーして渡します）
6. **「Deploy」** を押す
7. デプロイ完了後、その関数の **Settings** で
   **「Enforce JWT Verification」= OFF（無効）** になっていることを再確認

> 補足: サーバーの環境変数 `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は
> Supabaseが自動で用意しているため、こちらで設定する必要はありません。

### 動作テスト（任意）
ブラウザのアドレス欄に次を貼って開くと、動いているか確認できます（`xxxx`は適当な文字でOK）:

```
https://qgcgkrcrfzonmmygcdju.supabase.co/functions/v1/get-reservation-public?t=xxxx
```

`{"error":"invalid"}` のような短い返事が出れば、窓口は正常に動いています
（`xxxx`は正しい鍵ではないのでエラーが正解です）。

---

## ステップ3: 動作確認と本番公開（Claudeが担当）

ステップ1・2が終わったら Claude に「本番のDBとEdge Functionの設置が終わった」と伝えてください。

Claudeが以下を行います:
1. stagingプレビューURLで、実際にURLを発行 → お客さん画面が正しく出るか確認
2. 問題なければ staging を main にマージ（→ Vercelが自動で本番公開）
3. 本番の予約詳細に「お客様用 予約確認URLをコピー」ボタンが出ることを最終確認

---

## 使い方（公開後）

1. まず **店舗設定 → ルーム** で、各ルームに **住所** を入れて保存しておく
2. 予約の詳細を開く → **「お客様用 予約確認URLをコピー」** を押す
3. コピーされたURLをLINE／ショートメールに貼ってお客さんに送るだけ
4. お客さんはURLを開くと、予約日・ご案内時間・担当・コース・料金・住所（地図リンク付き）を見られる
5. URLは **予約日を過ぎると自動で無効** になります
   - 予約内容を編集したら、もう一度ボタンを押してURLを作り直して送ってください

---

## 困ったとき

- ボタンを押すと「URL作成に失敗しました」と出る → ステップ1のSQLが未実行の可能性
- お客さんが開くと「表示できませんでした」→ ステップ2のEdge Function未設置、またはVerify JWTがオンのまま
- 住所が表示されない → ルーム設定で住所を入れて保存したか確認

いずれもClaudeに状況を伝えれば調べます。
