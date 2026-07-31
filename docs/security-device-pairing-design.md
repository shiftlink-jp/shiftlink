# ログインセキュリティ改修 設計書（①②③一括）

作成: 2026-08-01 / ブランチ: `feat/device-pairing-security`（origin/main から分岐）

## 何を直すのか

本番の実コード・実データを調査して確認された、現在の3つの問題を一度にまとめて解消する。

| # | 問題 | 現状の根拠 |
|---|---|---|
| ① | ログイン済みセラピストが**同僚のPINを読める**（なりすまし可能） | `casts.pin` に平文12件。RLSは行単位のため同一店舗の全行が読める。列レベルの制限は無い |
| ② | 1人の打ち間違いで**全セラピストが15分ログイン不能** | `pin-login/index.ts:112` ロックキーが `castpin.<store_id>` ＝店舗共有 |
| ③ | **誰でもログイン窓口を叩ける**（妨害・名簿取得） | store_idはindex.htmlに平文。CORSはブラウザのみでcurlは素通り。`list-store-casts` はリクエスト認証なし |

②と③は表裏一体（窓口が公開されている限りDoS耐性とブルートフォース耐性はトレードオフ）のため、
**③の端末トークンを土台に②を再設計する**。①は独立だが同じPIN基盤に触るため同時に行う。

## 設計方針

大手POS（Square / Shopify POS）と同じ **2段階認証** に揃える。

1. **端末の認証**（初回のみ）: 店舗コードを入力 → サーバーが端末トークンを発行
2. **個人の認証**（毎回）: 従来どおりPIN＋生体認証

**最重要ポイント: 店舗の特定をクライアントからサーバーへ移す。**
現在は `store_id` をクライアントが送っているため誰でも任意の店舗を狙える。
改修後は **端末トークンから store_id をサーバー側で導出**し、クライアントからの store_id は受け付けない。
これにより「他店を狙う」「店舗を総当たりする」経路そのものが消滅する。

---

## DB変更（マイグレーション 026）

```sql
-- 端末トークン（ハッシュのみ保存。生トークンはDBに残さない）
CREATE TABLE store_devices (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id     uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,      -- sha256(生トークン)
  label        text,                       -- 「かなさんのiPhone」等
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
-- ペアリング用コード（48時間有効・1回使い切り）
CREATE TABLE store_pairing_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid NOT NULL,
  code_hash   text NOT NULL UNIQUE,        -- sha256(コード)。平文は保存しない
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 両テーブルとも RLS 有効・ポリシー無し＝service_role以外アクセス不可

-- ①: 平文PINを RLS全拒否の auth_pins へ移送
ALTER TABLE auth_pins ADD COLUMN IF NOT EXISTS pin_plain text;
UPDATE auth_pins ap SET pin_plain = c.pin
  FROM casts c WHERE ap.principal = 'cast.'||c.id AND c.pin IS NOT NULL
   AND ap.store_id IS NOT DISTINCT FROM c.store_id;
-- ※ casts.pin のNULL化は 026 では行わない。アプリ反映後に 027 で実施する（手順8）

-- ②: ロック記録に端末を持たせる
ALTER TABLE pin_login_attempts ADD COLUMN IF NOT EXISTS device_id bigint;
```

## Edge Function 変更

| 関数 | 変更内容 |
|---|---|
| **`pair-device`（新規）** | `{code}` を受け取り、有効・未使用・未期限切れを確認 → 端末トークン発行（32バイト乱数）→ `store_devices` にハッシュ保存 → 生トークンを1度だけ返す |
| **`manage-devices`（新規・オーナー限定）** | `issue_code`(コード発行48h) / `list`(端末一覧) / `revoke`(失効) / `rename` / `list_pins`(PINバッジ用) / `self_pair`(本人の端末登録) |
| **`pin-login`（改修）** | ①`device_token` 必須 ②トークンから store_id を導出（クライアントの store_id は無視）③ロックキーを `<principal>.<device_id>` ＝**端末単位**に変更 ④店舗全体のバックストップは高い閾値で残す |
| **`list-store-casts`（改修）** | `device_token` 必須。store_id はトークンから導出 |
| **`set-pin`（改修）** | PIN設定時に `auth_pins.pin_plain` も更新（①のバッジ表示を維持するため） |

### ②のロック設計（③が前提だからこそ成立する）

| 単位 | 閾値 | 目的 |
|---|---|---|
| 端末ごと | 5回 / 15分 | 打ち間違いの本人だけが待つ。**他人を巻き込まない** |
| 店舗全体 | 50回 / 60分 | 端末が乗っ取られた場合の最終防衛線（通常運用では絶対に到達しない値） |

端末トークンは**サーバー発行**なので攻撃者が偽造・使い捨てできない。
未ペアリングの相手はPIN照合に到達しないため、そもそも失敗カウントが増えない。

## アプリ（index.html）変更

1. 端末トークンを `localStorage` に保存（`sl_device_token`）
2. 起動時、トークンが無ければ **店舗コード入力画面**（新規）を表示
3. `pin-login` / `list-store-casts` 呼び出し時にトークンを送る
4. トークンが無効（失効・削除）と返ったら、トークンを消して店舗コード入力へ戻す
5. 管理画面に **「端末の管理」**（コード発行・登録端末一覧・失効）を追加
6. セラピスト管理のPINバッジを `manage-devices`(action=list_pins) の結果から描画（`casts.pin` 依存を除去）
7. **`index.html:4180` の旧経路** `casts.select('*').eq('pin',pin)` を削除（平文NULL化で機能しなくなるため）

## 移行のしかけ（全員が締め出される事故を防ぐ）

既存の15名の端末はトークンを持っていないため、そのまま強制すると**全員がログイン不能**になる。

→ **自動ペアリング期間**を設ける（既定 2026-09-01。環境変数 `PAIRING_GRACE_UNTIL` で上書き可）。

**fail-open設計**: 環境変数が未設定・書式不正でも猶予ONに倒す。fail-closedだと設定漏れやタイポで
全店が即ログイン不能になるため。締めるときはコード内の `DEFAULT_GRACE_UNTIL` を過去日にして明示的に行う。

- 期間中: `device_token` が無くてもPINログインを許可し、**成功したら自動で端末トークンを発行**して返す
- 期間中もPIN照合の成功が条件なので、無関係な第三者は登録できない
- 期間終了後: トークン必須。以後は店舗コードでのみ登録可能

これにより、スタッフは**何もしなくても普段通りログインするだけで登録が完了**する。

## 作業手順（本番反映）

事故を防ぐため、この順序を厳守する。

1. **バックアップ**: 現在の `pin-login` / `list-store-casts` / `set-pin` のコードをダウンロード保存（戻せる状態を作る）
2. マイグレーション026を適用（テーブル追加・平文移送）
   - ※この時点ではまだ平文NULL化は**しない**（アプリ側の準備が済むまで）
3. Edge Function を新規デプロイ（`pair-device` / `manage-devices`）
4. Edge Function を改修版に差し替え（`pin-login` / `list-store-casts` / `set-pin`）※猶予期間ONの状態で
5. アプリ（main）をデプロイ
6. 実機で確認（オーナー・セラピスト各1名）
7. 数日運用して全端末が自動ペアリングされたことを確認
8. `casts.pin` の平文NULL化を実行（①の完了）
9. 猶予期間を終了（③の完了）＝ `DEFAULT_GRACE_UNTIL` を過去日にして再デプロイ
   - ⚠️ この定数は **`pin-login` と `list-store-casts` の2ファイル**にある。`pin-login` だけ直すと
     セラピスト名簿（問題③）が開いたまま残るため、必ず両方を更新する
   - ⚠️ 環境変数 `PAIRING_GRACE_UNTIL` はタイポでも無言で猶予ONに戻る（fail-open設計のため）。
     締めた後は必ず検証する: トークン無しで `pin-login` を叩き **403 `need_pairing`** が返ることを確認
10. 027適用後、`index.html` のバッジのフォールバック `||c.pin` を削除（平文参照の完全除去）

**作業タイミング: 営業終了後の深夜。** ロールバックは各手順で可能（保存したコードに戻す）。

## この改修でも残るリスク（正直な記載）

技術で消せないものは残る。運用でカバーする。

- 店舗コードの漏洩（→48時間失効・遠隔失効で被害を限定）
- 端末の紛失・盗難（→管理画面から即失効）
- PINの覗き見・使い回し（→定期変更の運用ルール）
- 内部不正（権限保有者の悪用は技術では防げない）
- 外部サービス（Supabase / Vercel）側の障害・侵害
- PIN表示機能を残す限り、平文はどこかに存在する（金庫の中には入る）
- 緊急復旧コード（`BOOTSTRAP_PAIRING_CODE`）を設定する場合、その1本が漏れると端末登録が可能になる。
  オフラインで保管し、使用後は値を変更する運用にする。**十分に長い値**（20文字以上を推奨）にすること
  ※サーバ側の下限は4文字しかないため、短い値を設定すると総当たりの余地が生まれる
