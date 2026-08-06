# PIN認証本番化 → anon遮断 移行前 コード総点検（2026-06-11）

Phase1バックフィル完了後、ステップ2（PIN認証を本番デフォルト化）・ステップ4（anon遮断）
で壊れる箇所を昼間に総点検した結果。きっかけはbackfill直後のrooms 0件回帰（[feedback]参照）。

KYOUKANO store_id = `4cb3383a-31e5-408a-9f75-60a25943ac4d`

## 用語
- **ステップ2**: KYOUKANO本番(kyoukano.vercel.app)を `PIN_AUTH_MODE=true` / `PIN_STORE_ID=KYOUKANO_UUID`
  に切替。ログインが pin-login Edge Function 経由の**認証セッション**になる（[index.html:1419-1420]）。
- **ステップ4（anon遮断）**: `check_store_access` のanon分岐を `false` 化。anonは16テーブルに
  一切アクセス不可になる。＝セキュリティ監査CRITICAL #1の根治。

## 点検結果サマリー

| 項目 | 状態 | 備考 |
|---|---|---|
| rooms取得2箇所の `.is('store_id',null)` | ✅ 修正済(6fca2e6) | backfill直後に本番0件化→withStoreFilter統一 |
| 全データINSERTの withStoreId 付与 | ✅ 問題なし | 全`.insert`がwithStoreId。新規店舗シード(2267/2273/2279)は明示sid |
| error_logs insert (store_id無し) | ✅ 影響なし | error_logsはRLS無効・check_store_access対象外 |
| owner/cast PINログインハンドラ | ✅ PIN_AUTH_MODE対応済 | doOwnerLogin(2013)/doCastLogin(2078)→pinLoginViaServer |
| セッション復元(リロード) | ✅ 問題なし | initPinAuth(1503)がgetSession+store_members検証 |
| list-store-casts / pin-login | ✅ 問題なし | PIN_STORE_ID使用。backfillでcasts/store_settingsにUUID付与済 |
| 一般SELECTのstore_idフィルタ漏れ | ✅ 影響なし | フィルタ漏れ(under-filter)はRLSが救う。危険なのは過剰IS NULL(rooms既修正) |
| passkeyログイン(PIN_AUTH_MODE時) | ✅ 既に無効化 | 下記【訂正】。登録案内のみ抑止(c6804e5) |

## passkeyログイン 【当初🔴判定→精査の結果✅に訂正】

初回監査で「passkeyログインがセッション未発行→anon遮断で機能停止」と判定したが、呼び出し関係を
精査した結果、**PIN_AUTH_MODEではpasskeyログインは既に到達不可**で、ブロッカーではなかった。

- `autoPasskeyLogin`(1827)/`passkeyLogin`(1854)/`autoOwnerPasskeyLogin`(1654)/`ownerPasskeyLogin`(1677)
  は**呼び出し元ゼロのデッドコード**（onclickも無し）。passkeyボタン`btn-owner-passkey`/`btn-passkey`は
  **HTMLに存在しない**（getElementById→null、各関数は`if(!btn)return`で即抜け）。
- 実際に動くpasskeyログインは `doOwnerLoginSmart`(1939)/`doCastLoginSmart`(1972) 内のインライン処理
  のみ。両者とも先頭で `if(PIN_AUTH_MODE){ PIN値があればPIN経路; return }` と**PIN_AUTH_MODEでは
  passkeyをスキップ**する。
- ＝ステップ2でKYOUKANOをPIN_AUTH_MODEにすれば、passkeyログインは使われない。anon遮断後も
  passkeyで壊れるユーザーは出ない。PINログインはpin-login経由でセッション発行され無事。
- 補足: 現状のpasskeyは `public_key` に clientDataJSON を代用する**非検証の簡易UX実装**(1916-1917)。
  本物の暗号検証はしていない。

### 実施したOption B（commit c6804e5, staging）
唯一の残課題だった「PIN_AUTH_MODEでも `offerPasskeyRegistration` が登録を案内する」点を抑止
（`if(PIN_AUTH_MODE) return`）。使えない機能の登録を勧めないため。現状KYOUKANOはlegacyモードなので
本番実効果は無く、ステップ2で初めて有効になる準備変更。

### 将来のpasskey再実装（任意・セキュリティ移行の必須ではない）
生体認証UXを復活させたい場合は、WebAuthnアサーションをサーバ検証してセッションを発行する
`passkey-login` Edge Function（pin-loginと同設計）を新設する。ログイン前のcredential取得も
Edge Function(service_role)経由に。※public_key/credential_idは非機密（秘密鍵は端末内）。
これはanon遮断の前提ではなく、後日のUX改善として扱える。

## 改訂版・推奨順序
1. **【完了】Phase1バックフィル**（2026-06-11、2888件）
2. **【完了】rooms回帰修正**（6fca2e6）
3. **【完了】Option B: PIN_AUTH_MODEでpasskey登録案内を抑止**（c6804e5）
4. ステップ2: PIN_AUTH_MODE本番デフォルト化。設計案: `PIN_AUTH_MODE = !!_pinAuthParam || !SAAS_MODE`
   / `PIN_STORE_ID = _pinAuthParam || (SAAS_MODE?null:KYOUKANO_UUID)`。
   **前提確認: 非SaaSデプロイ＝KYOUKANOのみ、本番アクセスURLの確定**（ホスト名直書きを避けるため
   非SaaS全体をKYOUKANO扱いにする設計。要ユーザー確認）。staging予行→デプロイ→全機能再検証。
5. Stage3直前: 残NULL最終スイープ（backfill UPDATE再実行）。
6. ステップ4: anon遮断（check_store_accessのanon分岐をfalse化、ロールバックSQL常備）。

## 結論
コードベースは移行準備がほぼ整っている。当初ブロッカーと見たpasskeyは精査で非ブロッカーと判明
（PIN_AUTH_MODEで既に無効、登録案内のみ抑止済み c6804e5）。**残るはステップ2（PIN認証本番化）の
小さなコード変更＋「非SaaS=KYOUKANO」前提・本番URL確定＋ステップ3-4のSQL**。
ステップ2はstaging(?pinauth=KYOUKANO_UUIDで実データ予行可)で検証してから、オフタイムに
ステップ2デプロイ＋SQL(3-4)を一括カットオーバーするのが安全。
