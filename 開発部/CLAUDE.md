# 開発部

ShiftLinkアプリ（`index.html` 約8000行）のバグ修正・新機能実装・UI改善・パフォーマンス改善を担当。

## 担当作業
- バグの特定と修正
- 新機能の実装（画面・ボタン・処理の追加）
- UI/UX改善（見た目・操作性の向上）
- パフォーマンス改善（描画速度・処理の最適化）

## 絶対ルール（違反禁止）

### 1. 既存データを壊さない
- `store_id = NULL` の既存データへの影響はゼロにすること
- DB操作・マイグレーションは影響範囲を必ず事前確認する
- キャスト退店処理（deleteCast）では `works`, `shifts`, `cast_fees`, `reservations` を絶対に削除しない

### 2. 実装前に方針を確認する
- 大きな変更（画面構成の変更・DB設計・新テーブル追加など）は実装前にユーザーに確認する
- 複雑な問題・セキュリティ関連はOpusへの切り替えを提案する
- 「どう実装するか」より「何を実装するか」を先に合意する

### 3. コードにコメントを書かない
- コード自体で意図が伝わるように書く
- WHYが非自明な場合（隠れた制約・バグ回避）のみ1行まで許容
- 関数説明・引数説明などのdocコメントは不要

## 技術的な注意点

### index.html の構造
- 単一ファイルPWA、ビルドプロセスなし
- UIを隠す場合は `height:0;overflow:hidden`（`display:none` や DOM削除は禁止）
- 画面遷移は `.screen` divの `.on` クラスのtoggle
- ボトムシートは `closeSheet(id)` で閉じる

### XSS対策
- 動的文字列は必ず `escapeHtml(s)` を通してDOMに挿入する
- `innerHTML` への直接代入時は特に注意

### store_id の扱い
- INSERT時は `withStoreId(payload)` で自動付与
- SaaSモードのSELECTには `store_id` フィルタを追加する

### デプロイ
- `git push origin main` → Vercel自動デプロイ（PRなし、mainに直接push）
- ローカル確認: `python3 -m http.server 3100`

## よく触るファイル
- `index.html` — アプリ本体（全機能）
- `sw.js` — Service Worker（Push通知・PWAキャッシュ）
- `supabase/functions/` — Edge Functions（Push通知・Stripe決済）
- `supabase/migrations/` — DBマイグレーション

## アウトプット形式
- 修正内容・変更箇所を簡潔に報告する
- ファイル名と行番号を明記する（例: `index.html:1234`）
- 懸念点・残課題があれば必ず伝える
