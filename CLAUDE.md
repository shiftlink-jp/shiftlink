# ShiftLink — CLAUDE.md

## プロジェクト概要

メンズエステ店舗向けの**シフト・予約・売上管理PWA**。
単一ファイル構成（`index.html` 約8000行）で全機能を実装。

- **本番URL**: https://kyoukano.vercel.app（Vercelで自動デプロイ）
- **リポジトリ**: https://github.com/sawaki-nagoya/shiftlink
- **デプロイ**: `git push` → main → Vercel自動デプロイ

---

## 技術スタック

| 要素 | 内容 |
|------|------|
| フロントエンド | 単一ファイルPWA（`index.html`）、バニラJS/CSS |
| バックエンド | Supabase（本番: `qgcgkrcrfzonmmygcdju`） |
| Edge Functions | Supabase Functions（send-push, stripe-webhook等） |
| デプロイ | Vercel（mainブランチへのpushで自動デプロイ） |
| 通知 | Web Push（VAPID、sw.js経由） |
| 決済 | Stripe（将来SaaS課金用） |

---

## ファイル構成

```
index.html          # 全コード（HTML/CSS/JS 約8000行）
sw.js               # Service Worker（Push通知 + キャッシュ制御）
manifest.json       # PWAマニフェスト
legal.html          # 利用規約・プライバシーポリシー
supabase/
  functions/
    send-push/      # Push通知送信 Edge Function
    stripe-webhook/ # Stripe webhook Edge Function
    stripe-checkout/# Stripe Checkout Edge Function
    notify-line/    # LINE通知 Edge Function
  migrations/
    001_saas_multi_tenant.sql  # storesテーブル + 全テーブルにstore_id追加
    002_rooms_and_seed.sql     # roomsテーブル + 既存ルームデータ投入
    003_extra_json_columns.sql # cast_feesにextra_*_backs JSONカラム追加
docs/
  multi-tenant-design.md      # SaaS化設計書
```

---

## 主要グローバル変数

```javascript
let me = null           // ログイン中のユーザー（キャストまたはオーナー）
let courses = []        // コース一覧（DBから取得）
let opts = []           // オプション一覧（DBから取得）
let storeSettings = {}  // 店舗設定（DBから取得）
let roomList = []       // ルーム一覧（DBから取得）
let sheetFee = {}       // 現在開いている委託金シート
let myShifts = []       // 自分のシフト一覧
```

---

## 認証・モード

### PINログイン（現行）
- キャスト: セラピスト一覧から選択
- オーナー: `OWNER_PIN`（DB `store_settings.owner_pin` から読込、デフォルト`2580`）

### SaaSモード（開発中）
- URL: `?saas` パラメータ または `app.shiftlink.jp` ホスト名
- `SAAS_MODE = true` になりSupabase Auth（メール/パスワード）使用
- 別Supabaseプロジェクト（`fewuonnrgqnxtopkjudt`）を使用

```javascript
const SAAS_MODE = new URLSearchParams(location.search).has('saas')
               || location.hostname === 'app.shiftlink.jp'
```

---

## データベース設計のポイント

### store_id の扱い
- 既存データは `store_id = NULL`（既存PINアプリはNULLを参照）
- 新規SaaSデータは `store_id = UUID`
- INSERTは `withStoreId(payload)` ヘルパーで自動付与

```javascript
function withStoreId(payload) {
  if (!SAAS_MODE || !currentStoreId) return payload
  return { store_id: currentStoreId, ...payload }
}
```

### 委託金（cast_fees）のJSON拡張カラム
| カラム | 用途 |
|--------|------|
| `extra_course_backs` | コース別バック `{ "course_{id}": 金額 }` |
| `extra_op_backs` | オプション別バック `{ "op_{id}": 金額 }` |
| `extra_trial_op_backs` | 体験期間オプション別バック `{ "trial_op_{id}": 金額 }` |

レガシー固定カラム（`op_gokueki`, `op_isho`, `op_isho2`等）は後方互換のため残存。
**新規実装は必ずJSON拡張カラムを優先**し、固定カラムはフォールバックのみ。

### ルーム（rooms テーブル）
- 店舗固有のルーム情報はDBから取得（ハードコードなし）
- `store_id = NULL` が既存店舗のルーム
- `getROOMS()`, `getRoomColor(name)`, `buildRoomButtons(sid)` で取得

---

## Push通知

### 構成
- VAPID公開鍵: `BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E`
- `push_subscriptions` テーブルに `cast_id` + `subscription` JSON を保存
- オーナー通知: `cast_id = 0`、キャスト通知: `cast_id = キャストのid`

### 送信
```javascript
await sendPushNotification(castId, title, body)
// → /functions/v1/send-push を呼び出す
```

### 登録・復元の仕組み
1. ログイン時: ブラウザのsubscriptionとDBのendpointを比較
2. 一致 → 「設定済み」表示
3. subscription消失 + DB登録あり + 通知許可済み → 自動復元（resubscribe + DB更新）
4. SW `pushsubscriptionchange` イベント → メインスレッドに通知

### SW バージョン管理
`SW_VER` を変更するとSWが更新される（デプロイ時に変えない限り通知は維持される）。
現在: `v13`（`index.html` L293 と `sw.js` L1）

---

## 主要な計算ロジック

### 利益計算
```javascript
// works.net = back - misc（保存時にmiscを引いた値）
// profit = sales - net（miscの二重計上に注意）
profit = gross_work - net  // ← miscを引かない
```

### 委託金バック取得（getOptBack2）
```javascript
// 優先順位:
// 1. extra_trial_op_backs[trial_op_{id}]（体験期間）
// 2. extra_op_backs[op_{id}]
// 3. レガシー固定カラム（op_gokueki等）
```

---

## PC表示

- 幅768px以上: `.screen` を最大680px（タブによって変化）
- 幅1024px以上: `.screen` を最大780px
- ワイド対象タブ: `owner-monthly`, `owner-cast`, `owner-customer`, 管理画面
- `tab()` / `tabMgmt()` 関数が `pc-wide` クラスをtoggle

---

## SaaS化の進捗（Phase 1完了）

### 完了
- [x] rooms テーブル化（ハードコードルーム削除）
- [x] opts グローバル化（fixedOpts削除）
- [x] extra_course_backs / extra_op_backs / extra_trial_op_backs JSON対応
- [x] 全テーブルに store_id カラム追加（migration 001）
- [x] stores / store_members テーブル作成

### 未完了
- [ ] Phase 2: 全SELECTクエリに store_id フィルタ追加（約150箇所）
- [ ] Phase 3: RLS有効化（既存テーブル）
- [ ] Phase 4: 新規店舗オンボーディング画面

詳細は `docs/multi-tenant-design.md` 参照。

---

## 作業ルール

- **既存アプリへの影響ゼロを最優先**（store_id=NULLの既存データが壊れないこと）
- 編集は `index.html` 直接（ビルドプロセスなし）
- `python3 -m http.server` でローカル確認
- コミット後 `git push` で Vercel 自動デプロイ
- 管理画面への直接ログインは禁止（Claudeがデータ取得・分析するために使用しない）
- mainブランチに直接push（featureブランチ不要）
