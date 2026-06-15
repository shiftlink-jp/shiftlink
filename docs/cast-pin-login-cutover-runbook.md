# セラピストPINログイン刷新 本番反映ランブック（2026-06-15）

## 概要
セラピストのログインを「名前選択 → PIN」から **「PINだけ（名前選択なし）＋生体認証」** に刷新。
店舗ログインは方式そのままで、生体認証の誤エラー表示を修正。PIN重複登録の防止も追加。

## 既に本番(qgcgkrcrfzonmmygcdju)反映済み（バックエンド）
- Edge Function **pin-login**：cast_id省略時にPINから本人特定（後方互換＝旧経路も温存）
- Edge Function **set-pin**：同店舗でPIN重複なら拒否(409)
- DB関数 **resolve_cast_pin** ＋ **auth_pins.pin_lookup** 列＋索引（ブラインド索引・HMAC）
- DB関数 **set_pin_hash**：pin_lookup も更新するよう改定
→ これらは後方互換。**現行の旧ログイン画面のまま本番は正常稼働中**。

## 2026-06-15 先行反映済み（選択B）
- セラピストの「コールドスタートで毎回ログインに戻る」修正だけを先に main へ反映済み（SW **v21**・ad9c6aa/f57acce）。
- PIN刷新は未反映。staging再整合済で `staging..main=0`＝下の反映は**早送り**。2時は SW **v21→v22**。

## 残作業（= 2時以降にやる本番反映）
フロント（index.html＝新ログイン画面）と sw.js(v21) を main へ。**これだけ**で本番のログイン画面が新方式に切替わる。

### 反映手順
```
cd /Users/konnoren/shiftlink
git rev-parse main            # ← ロールバック用に現在のmain SHAを控える（例: a4df3c8…）
git checkout main
git merge staging             # 早送り（fast-forward）。競合なしを確認済み
git push origin main          # Vercelが本番を自動デプロイ（1〜2分）
```
main に乗るのは staging の最新まで（e70aad6 以降）。セラピストPIN刷新＋PIN照合のブラインド索引化＋
「コールドスタートでも10分以内は自動入室」(個人スマホのセラピストが毎回ログインに戻る不具合の修正)を含む。
変更ファイル: index.html / pin-login / set-pin / 015_*.sql / sw.js。

### 反映後の確認（本番URL = https://kyoukano.vercel.app/index.html）
1. **デプロイ完了待ち**（Vercel Deployments が Ready）。インストール済みPWAは**一度閉じて開き直す**と v22 に更新。
2. **店舗ログイン**：PINで入れる／開いた時に「生体認証に失敗」の誤表示が出ない。
3. **セラピストログイン**：名前リストが無くPIN入力が直接出る → 実PINでログイン → 正しい本人になる。
   - 同じ子で2回ログイン → 2回目はほぼ瞬時（索引が効く）。
   - 端末に生体認証登録済みなら「🔐 生体認証でログイン」ボタンが出る。
4. **10分キープ（コールドスタート）**：ログイン後、別アプリへ切替→戻る／アプリを終了→再起動しても、
   10分以内ならログイン画面に戻らず維持される（店舗・セラピスト両方）。10分超で再ログイン。
5. **PIN重複**：管理→セラピストのPIN変更で他の人と同じ番号 → 「このPINは他のセラピストが使用中です」。

### 注意・周知
- **生体認証は全員、新方式で登録し直し**が必要（PINはそのままでOK）。
- 各セラピストの**初回ログインだけ**従来速度（その際に索引を記録）、以降は永久に速い。

### ロールバック（万一）
フロントだけ戻せばよい（バックエンドは後方互換なので旧フロントでも動く）:
```
git checkout main
git reset --hard <控えた旧main SHA>
git push --force origin main   # Vercelが旧フロントを再デプロイ
```
DB/関数は触らない（戻す必要なし）。

## 補足
- ローカル確認は `python3 -m http.server 3200` → http://localhost:3200/index.html （CORS許可済みポート: 3100/3200/3300）。
- ブラインド索引のペッパーは resolve_cast_pin / set_pin_hash 内に保持（API非公開）。
