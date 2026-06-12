# PIN隔離（#1）テスト環境 予行手順 ＆ チェックリスト

対象: `011_secure_pins.sql` / `012_clear_legacy_pins.sql` / `pin-login`改修 / `set-pin`新設 / `index.html`改修
目的: 本番KYOUKANOに一切触れず、#1対策（PINのauth_pins隔離＋bcrypt＋PIN認証経路）を
テスト環境でフル検証し、前回(Phase1)のような回帰を事前に洗い出す。

---

## ⚠️ 最重要: なぜ「本番と分離したDB」で予行するのか

`011`/`012` は特定店舗だけでなく **全テーブルのPINに作用** する。とくに `012`（平文PINの
NULLクリア）は **本番KYOUKANOの `casts.pin` / `store_settings.owner_pin` も消す**。
本番KYOUKANOは今もアプリ側でPIN平文を照合しているため、本番DBで `012` を流すと
**本番が全員ログイン不能**になる。

→ **予行は必ず本番(`qgcgkrcrfzonmmygcdju`)とは別のDBで行う。** 本番DBには `012` を流さない。

---

## 予行環境の選択

### 案A（推奨）: Supabase Branching で本番のコピーを作る
- 本番プロジェクトの一時ブランチDB（スキーマ＋データのコピー）を作成。
- 利点: 本番と**同一スキーマ**（ドリフトの心配なし）、隔離、終わったら破棄。
- このブランチDBに `011`→`012` を流し、ブランチのURL/キーでアプリを動かす。

### 案B: SaaS開発DB（`fewuonnrgqnxtopkjudt`）で予行
- アクセス方法: アプリURLに **`?saas&pinauth=<開発DBのテスト店舗ID>`** を付ける。
  - `?saas` → 接続先が開発DBになる
  - `?pinauth=<id>` → PIN認証画面（pin-login経由）で動く（`init()`はPIN_AUTH_MODE優先）
- ⚠️ 注意: 開発DBは**本番とスキーマがズレている可能性**（[[test-env-and-schema-findings]]）。
  事前に下記「事前準備」のスキーマ確認を必ず実施する。

> どちらを使うかは運用者判断。スキーマ一致を重視するなら案A、手軽さなら案B。
> 以降の手順は「予行DB」= 選んだ分離環境 を指す。

---

## 事前準備チェックリスト

- [ ] 予行DBを用意（案A: ブランチ作成 / 案B: 開発DB）
- [ ] 予行DBに必要テーブルが存在: `casts`(pin列), `store_settings`(owner_pin列), `store_members`,
      `stores`, `pin_login_attempts`(010), RLS関連(005/008) が入っていること
- [ ] 予行DBにテスト店舗を用意（store_id・オーナーPIN・キャスト＋PINを既知の値で登録）
      ※ 例: オーナーPIN `123456`、キャスト1名 PIN `2222`（4桁以上で）
- [ ] 予行DBに Edge Function をデプロイ: `pin-login`(新版) / `set-pin`(新規) / `list-store-casts`
      （`supabase functions deploy <name> --project-ref <予行DBのref>`）
- [ ] Edge Function のシークレット確認: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
      `SUPABASE_ANON_KEY` が予行DBの値になっていること
- [ ] アプリを予行DBに向ける（案A: 一時的にURL/KEY差し替え or ブランチのプレビュー /
      案B: `?saas&pinauth=<テスト店舗ID>`）
- [ ] 予行DBの現状PINを記録（後で照合確認用）

---

## 適用＆検証 手順

### 手順1: `011` 適用（auth_pins作成＋bcrypt移行＋関数。平文は温存）
- [ ] `011_secure_pins.sql` を予行DBで実行（エラーなく完了）
- [ ] `SELECT principal, store_id, left(pin_hash,7) FROM auth_pins ORDER BY principal;`
      → owner / cast.* が並び、`pin_hash` が `$2a$12$…`（bcrypt）であること
- [ ] `SELECT public.verify_pin('<store_id>'::uuid,'owner','<正しいPIN>');` → **t**
- [ ] `SELECT public.verify_pin('<store_id>'::uuid,'owner','<誤ったPIN>');` → **f**
- [ ] `SELECT count(*) FROM casts WHERE pin IS NOT NULL;` → まだ平文が残る（>0でOK、012前なので）

### 手順2: アプリでPIN認証ログイン（011時点・auth_pins経由で照合されること）
- [ ] オーナーPINで正常ログイン
- [ ] キャストPINで正常ログイン
- [ ] 誤ったPINで失敗 → 5回連続失敗で429ロック（`pin_login_attempts`動作）

### 手順3: `012` 適用（平文PINをNULLクリア）
- [ ] `012_clear_legacy_pins.sql` を予行DBで実行
- [ ] `SELECT count(*) FROM casts WHERE pin IS NOT NULL;` → **0**
- [ ] `SELECT count(*) FROM store_settings WHERE owner_pin IS NOT NULL;` → **0**
- [ ] 直後にオーナー／キャストで**再ログイン**できる（auth_pinsのみで照合）

---

## 機能チェックリスト（012適用後）

- [ ] オーナーPINログイン（正PIN成功 / 誤PIN失敗）
- [ ] キャストPINログイン（正PIN成功 / 誤PIN失敗）
- [ ] **PIN変更**（changePIN）: 新PINでログイン成功・旧PINで失敗（set-pin→auth_pins更新が効く）
- [ ] **オーナーPIN変更**（料金設定シート）: 新PINでログイン成功・旧PINで失敗
- [ ] **新規キャスト追加**: pinなしでcasts作成＋set-pinでPIN設定 → そのキャストでログイン成功
- [ ] **オンボーディング**（案Bで`?saas`のSaaS新規作成時）: 初期オーナーPIN設定→ログイン成功
- [ ] 新規/変更PINで **4桁未満を拒否**、4〜8桁を許可
- [ ] （該当あれば）既存の3桁以下PIN保持者が**ログインは引き続き可能**（下限据置の確認）
- [ ] PIN変更画面で「現在のPIN」が表示されない（`••••（変更のみ可能）`になる）

---

## セキュリティチェックリスト（#1が塞がれたことの確認）

**キャストでログインした状態**で、ブラウザのDevToolsコンソールから実行:

- [ ] `await sb.from('store_settings').select('owner_pin').then(r=>r.data)`
      → `owner_pin` が **null**（オーナーPINを取得できない）
- [ ] `await sb.from('casts').select('id,name,pin').then(r=>r.data)`
      → 全行の `pin` が **null**（他キャストのPINを取得できない）
- [ ] `await sb.from('auth_pins').select('*').then(r=>r)`
      → **0件 or エラー**（RLSでキャストは一切読めない）
- [ ] `await sb.rpc('verify_pin',{p_store_id:'<id>',p_principal:'owner',p_pin:'0000'}).then(r=>r)`
      → **権限エラー**（service_role専用。キャストはPINオラクルにできない）
- [ ] `await sb.rpc('set_pin_hash',{p_store_id:'<id>',p_principal:'owner',p_pin:'9999'}).then(r=>r)`
      → **権限エラー**（キャストが任意PINを設定できない）
- [ ] キャストのセッションで `set-pin` Edge Function を直接叩く → **403（権限がありません）**

---

## 回帰チェックリスト（前回の教訓: 認証以外が壊れていないか）

- [ ] **Push通知**: 購読登録できる／オーナー(cast_id=0)・キャスト双方に通知が届く
- [ ] **ルーム表示**: ルーム一覧が表示される（0件化していない）
- [ ] 予約登録・委託金計算が正常
- [ ] シフト申請・承認が正常
- [ ] 顧客登録・来店履歴が正常
- [ ] （あれば）既存 Playwright E2E `phase2_*` を予行DB向けに流して緑
- [ ] 別のテスト店舗を作って**相互不可視**（店舗A↔店舗Bでデータが混ざらない）

---

## 合否基準 ＆ 撤収

- 合否: 上記すべてのチェックが pass。1つでも fail なら本番適用は保留し原因修正。
- 撤収:
  - 案A: ブランチDBを破棄。
  - 案B: 予行で作ったテストデータ（`Playwright自動テスト_`等）と auth_pins の予行レコードを削除。
- 予行完了後、本番適用は `docs/secure-pins-runbook.md` の順序で（カットオーバーと統合して計画）。

---

関連: `docs/secure-pins-runbook.md`（本番適用手順） / `docs/cutover-runbook-20260611.md`（anon→PIN認証移行）
