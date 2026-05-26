# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

メンズエステ店舗向け**シフト・予約・売上管理PWA**（ShiftLink）。
単一ファイル構成（`index.html` 約8000行）で全機能を実装。ビルドプロセスなし。

- **本番URL**: https://kyoukano.vercel.app / https://app.shiftlink.jp（SaaS）
- **デプロイ**: `git push origin main` → Vercel自動デプロイ（mainブランチ直接push、PRなし）
- **ローカル確認**: `python3 -m http.server 3100`（npx使用不可）

## 技術スタック

- フロントエンド: バニラJS/CSS、単一ファイルPWA（`index.html`）
- バックエンド: Supabase（本番: `qgcgkrcrfzonmmygcdju`）
- Edge Functions: Supabase Functions（send-push, stripe-webhook, stripe-checkout, create-trial-subscription, notify-line）
- 通知: Web Push（VAPID、sw.js経由）
- 決済: Stripe（SaaS課金用、現在テストモード・API version: `2024-06-20`）
- SaaS開発用Supabase: `fewuonnrgqnxtopkjudt`

## 作業ルール

- **既存アプリへの影響ゼロが最優先**（store_id=NULLの既存データが壊れないこと）
- UIを隠す場合、DOM要素を削除せず `height:0;overflow:hidden` で非表示にする（JSが参照するDOM要素を消すと壊れる）
- mainブランチに直接push（featureブランチ不要）
- 管理画面への直接ログインは禁止（Claudeがデータ取得・分析のために使わない）
- 複雑な問題・重要な設計判断・セキュリティ関連の場合は、Opusへの切り替えを提案すること

## アーキテクチャ

### 画面遷移

`.screen` divの `.on` クラスをtoggleして画面を切り替える（SPAルーティングなし）。

```
s-top          → ログイン選択画面
s-owner-login  → オーナーPINログイン
s-cast-login   → キャストPINログイン
s-saas-login   → SaaSメール/パスワードログイン
s-app          → メインアプリ（ログイン後すべてここ）
```

`tab(name)` でアプリ内タブを切替、`tabMgmt()` / `tabMgmtSub(name)` で管理画面タブ切替。

### ボトムシート

`closeSheet(id)` でシートを閉じる。シートは `id="sheet-xxx"` のdivで、`.open` クラスで表示制御。
新規シートは既存のHTMLパターンに従って追加する。

### 認証

- **PINログイン（現行）**: キャスト一覧から選択、オーナーはDB `store_settings.owner_pin`
  - `OWNER_PIN` はデフォルト空文字。未設定時はログイン拒否。
  - sessionStorage には生のPINではなくハッシュトークン（`makeOwnerTok(pin)`）を保存して検証。
- **SaaSモード**: `?saas` パラメータ or `app.shiftlink.jp` → `SAAS_MODE = true` → Supabase Auth使用

### 主要グローバル変数

```javascript
let me = null           // ログイン中ユーザー
let courses = []        // コース一覧
let opts = []           // オプション一覧
let storeSettings = {}  // 店舗設定
let roomList = []       // ルーム一覧
let sheetFee = {}       // 委託金シート
```

## セキュリティ実装（2026-05時点）

### XSS対策
- `escapeHtml(s)` ヘルパー（L1134）をHTML出力全箇所に適用済み
- 顧客名・キャスト名・コース名など動的文字列はすべてescapeHtml経由でDOMに挿入

### オーナーPIN保護
- `makeOwnerTok(pin)` でソルト付きハッシュを生成し sessionStorage に保存
- セッション復元時にトークン照合でPINを検証（生PINはメモリのみ）

### Edge Functions セキュリティ
- **CORS**: `ALLOWED_ORIGINS` ホワイトリスト方式（`stripe-checkout`, `create-trial-subscription`）
- **エラー区別**: 日本語メッセージ（ユーザー起因）→ 400、サーバー障害 → 500
- **idempotencyKey**: `create-trial-${store_id}-${日付}` でダブルクリック重複防止
- **webhook**: シグネチャ検証と処理を分離、処理エラーは500返却でStripe再送を活用

### SaaS store_id フィルタ
- `courses`, `options`, `rooms`, `push_subscriptions` の取得時にSaaSモードで `store_id` フィルタ適用済み
- INSERT時は `withStoreId(payload)` で自動付与

## データベース設計の要点

### store_id
- 既存データ: `store_id = NULL`（PINアプリ）
- SaaS新規: `store_id = UUID`
- INSERT時は `withStoreId(payload)` で自動付与

### マイグレーション一覧

| ファイル | 内容 | 適用先 |
|---|---|---|
| `001_saas_multi_tenant.sql` | stores/store_members作成、既存テーブルにstore_id追加 | dev |
| `002_rooms_and_seed.sql` | roomsテーブル化 | dev |
| `003_extra_json_columns.sql` | cast_feesにJSONカラム追加 | dev |
| `004_customer_no_unique.sql` | customer_noのUNIQUEインデックス（競合対策） | **本番・dev両方** |

### 顧客番号（customer_no）の採番
- UNIQUE制約: `COALESCE(store_id::text, '_default')` + `customer_no` の複合ユニークインデックス
- クライアント側: 重複時（23505エラー）に最大5回リトライし、DB再取得でno再計算

### キャスト退店処理（deleteCast）
**過去の売上・シフト・委託金は税務・帳簿用に保持する。絶対に削除しない。**
- 削除対象: `cast_discounts`（キャスト固有の割引設定）、`casts`（キャスト本体）
- 保持対象: `works`, `shifts`, `cast_fees`, `reservations`（過去データすべて）

### 支払い方法（optPay）
オプションごとに現金/カードを選択可能。`reservations.payment` JSON内の `optPay` マップで管理。

```javascript
const optPayMap = pj.optPay || {};
// optPayMap[optionName] → '現金' or 'カード'
// 旧データ互換: optPayMap[n] || payOpt でフォールバック
```

関連箇所: `castAddOption`, `castExtend`, `castOpenPayment`, `openRvDetail`, `addSession`, `calcTotal2`, `saveWork`, `calcRv`

### 委託金（cast_fees）JSON拡張
| カラム | 用途 |
|--------|------|
| `extra_course_backs` | `{ "course_{id}": 金額 }` |
| `extra_op_backs` | `{ "op_{id}": 金額 }` |
| `extra_trial_op_backs` | `{ "trial_op_{id}": 金額 }` |

新規実装はJSON拡張カラムを優先。レガシー固定カラム（`op_gokueki`等）はフォールバックのみ。

### 利益計算
```javascript
// works.net = back - misc（保存時にmiscを引いた値）
// profit計算ではmiscの二重計上に注意
profit = gross_work - net  // miscを引かない
```

## Push通知

- VAPID公開鍵: `BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E`
- `push_subscriptions` テーブル: `cast_id=0` がオーナー、それ以外がキャスト
- SaaSモードでは `store_id` フィルタを追加して他店舗に通知が飛ばないようにする
- `sendPushNotification(castId, title, body)` → Edge Function `/functions/v1/send-push`
- SW バージョン: `SW_VER`（`index.html` と `sw.js` 両方を揃えて更新）

## PC表示

- 768px以上: `.screen` max-width 680px
- 1024px以上: max-width 780px
- ワイド対象タブ: `owner-monthly`, `owner-cast`, `owner-customer`, 管理画面 → `pc-wide` クラス

## SaaS化の進捗

- [x] Phase 1: rooms テーブル化、opts グローバル化、JSON拡張、store_id追加、stores/store_members作成
- [x] store_id フィルタ: courses / options / rooms / push_subscriptions に追加済み
- [x] Stripe Edge Functions: 全3関数デプロイ済み（shiftlink-dev: fewuonnrgqnxtopkjudt）
- [x] trial_will_end webhook ハンドラ実装済み
- [ ] Phase 2: 全SELECTに store_id フィルタ追加（約150箇所、残り多数）
- [ ] Phase 3: RLS有効化（既存テーブル）
- [ ] Phase 4: 新規店舗オンボーディング画面
- [ ] Stripe本番モード切替
- [ ] tokutei.html: 事業者情報（●●）をバーチャルオフィス登録後に記入

詳細は `docs/multi-tenant-design.md` 参照。

---

## 🗂️ 部署一覧

| エージェント名 | 部署名 | 主な担当 |
|---|---|---|
| `@coo` | **COO（統括）** | **全部署への指示出し・調整・統合。迷ったらここ** |
| `@dev` | 開発部 | アプリの修正・改善・リファクタリング |
| `@marketing` | マーケティング・リサーチ部 | 競合調査・市場分析・戦略立案・コピー・プロモーション |
| `@planning` | 企画提案部 | 新機能・企画書・ロードマップ |
| `@qa` | テスト部 | 品質検証・テスト作成・バグレポート |

## 💬 呼び出し方
@coo 今月やるべきことを整理して各部署に指示を出して  ← 何でもここから
@dev バグを直して
@marketing 競合を調べてプロモーション案を出して
@planning 新機能の企画書を作って
@qa このコードをテストして
