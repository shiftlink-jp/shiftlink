# PIN隔離（#1 権限昇格対策）本番適用手順書

作成日: 2026-06-12 / 対象: 監査指摘 #1（RLSの役割分離欠如によるPIN漏洩・権限昇格）

## 何を直すか

従来 `store_settings.owner_pin` と `casts.pin` は**平文**で保存され、RLS（`check_store_access`）が
同一店舗内を無制限に許すため、PINログインした一般キャスト(staff)が
**オーナーPINや他キャストのPINをそのまま SELECT できた**（→ オーナー権限奪取・なりすまし）。

対策として PIN本体を **RLS全拒否の専用テーブル `auth_pins`** へ隔離し、**bcrypt**（pgcrypto の
slow hash）で保存する。ハッシュ計算・照合は **Postgres 内の関数 `verify_pin` / `set_pin_hash`**
（SECURITY DEFINER・**service_role 専用**）に閉じ、Edge Function はそれを RPC で呼ぶだけ
（Deno 側でハッシュを再現しない＝言語間不整合と弱いハッシュを排除）。`auth_pins` は service_role
以外アクセス不可で、キャストは PIN もハッシュも一切取得できない。`casts.pin` /
`store_settings.owner_pin` は NULL クリアする（列は温存）。

> なぜ bcrypt か: PINは数字のみ・短く鍵空間が小さいため、高速ハッシュ(SHA-256)はバックアップ
> 流出時に総当たりで即破られる。bcrypt で**オフライン総当たりコストを上げる**（オンライン総当たりは
> `pin_login_attempts`(010) で別途レート制限）。あわせて**新規PINは4〜8桁を必須**にした
> （1〜3桁はどんなハッシュでも保護不能なため。既存の短いPINでのログインは引き続き可能＝ロックアウト回避）。

## 変更ファイル

| 種別 | ファイル | 内容 |
|---|---|---|
| Migration | `supabase/migrations/011_secure_pins.sql` | `auth_pins`作成（RLS全拒否）＋既存平文をbcrypt移行（平文は温存）＋`verify_pin`/`set_pin_hash`関数（service_role専用） |
| Migration | `supabase/migrations/012_clear_legacy_pins.sql` | `casts.pin` / `store_settings.owner_pin` を NULL クリア |
| Edge Function | `supabase/functions/pin-login/index.ts` | `auth_pins`ハッシュ照合に変更（未移行なら平文フォールバック） |
| Edge Function | `supabase/functions/set-pin/index.ts` | **新規**。オーナー認証のうえ PIN を `auth_pins` へ保存 |
| Client | `index.html` | PIN設定/変更/オンボーディングを `set-pin` 経由に。owner_pin の読込/表示を撤去 |

## ⚠️ 適用順序（厳守。無停止移行のため）

順序を誤ると一時的に全ログイン不能・PIN不整合が起きる。**必ず以下の順で**。

1. **Edge Function をデプロイ**（先にサーバを新版へ）
   ```
   supabase functions deploy pin-login
   supabase functions deploy set-pin
   ```
   - この時点で `pin-login` は `auth_pins` を優先するが、まだ無いので**平文フォールバック**で従来通り動く。

2. **Migration 011 を適用**（auth_pins 作成＋ハッシュ移行。平文はまだ残る）
   ```
   supabase db push        # もしくは 011 を SQL エディタで実行
   ```
   - 適用後、`pin-login` は `auth_pins` のハッシュで照合するようになる（平文はバックアップとして残存）。
   - 確認: `SELECT principal, store_id FROM auth_pins ORDER BY principal;` に owner / cast.* が並ぶこと。

3. **index.html（クライアント新版）を本番反映**
   - `staging` で動作確認 → `main` にマージ → Vercel 自動デプロイ。
   - これで PIN 設定/変更が `set-pin` 経由になり、平文列にはもう書かれない。

4. **Migration 012 を適用**（平文 NULL クリア）
   ```
   supabase db push        # もしくは 012 を SQL エディタで実行
   ```
   - 確認:
     ```
     SELECT count(*) FROM casts WHERE pin IS NOT NULL;             -- → 0
     SELECT count(*) FROM store_settings WHERE owner_pin IS NOT NULL; -- → 0
     ```
   - この後、`pin-login` の平文フォールバックは到達しなくなる（auth_pins のみで照合）。

> **注意**: 手順3が本番反映される前に管理画面で PIN を変更すると、旧クライアントが
> NULL化対象の平文列に書き込み、`auth_pins` と不整合になる。**3→4 は間を空けず連続で**行うこと。

## 必要なシークレット

- `pin-login` / `set-pin` は既存の `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` を使用（追加不要）。

## ロールバック

- 011/012 適用後に問題が出た場合、平文は 012 実行までは残っている。
  012 実行前なら旧版 `pin-login`（平文照合）に戻すだけで復旧可能。
- 012 実行後に戻す必要が生じた場合は `auth_pins` から復元できない（ハッシュのため）。
  各店舗にPIN再設定を依頼するか、バックアップから平文列を復元する。
  → **012 適用前に DB バックアップ（特に `casts.pin` / `store_settings.owner_pin`）を取得しておくこと。**

## 残課題（本対策のスコープ外・別途）

- `casts` / `store_settings` 以外にも、RLS が「店舗内は無制限」のため、キャストが他キャストの
  売上・委託金(`cast_fees`)・顧客PII(`customers`)を読み書きできる点は未対応。
  役割ベース（owner/staff）のRLSポリシー細分化は別タスクで対応する。
- 監査 #2（send-push が公開anon鍵で誰でも呼べる）も別途対応。
