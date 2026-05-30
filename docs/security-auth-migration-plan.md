# セキュリティ本丸対策：KYOUKANO認証移行プラン

作成: 2026-05-30 / 対象課題: CRITICAL（公開anon鍵で全PIIがCRUD可能・owner_pin露出）

## 1. 問題の本質
現状のPINアプリは「公開anon鍵 + クライアント側PIN照合」だけで動く。RLSのanonポリシーが
`store_id IS NULL`（＝KYOUKANOの全データ）を匿名に開放しているため、アプリから抜き出せる
公開anon鍵だけで、認証なしに顧客PII・売上・owner_pinの **read/insert/update/delete** が可能。
→ 仕切り(RLS)では守れない。**サーバ側の本物の認証**を導入し、anonのデータアクセスを断つ以外に
本質的解決はない。

## 2. 目標状態
- すべてのデータアクセスは「認証済みセッション(auth.uid()あり)」経由のみ。
- anon（auth.uid()なし）はデータに一切アクセスできない。
- KYOUKANOは store_id を持つ1店舗として扱い、所属メンバーだけが自店データにアクセス。
- PINのUXは維持しつつ、PIN照合を**サーバ側**で行いセッションを発行する。

## 3. 設計：PINを本物の認証に変える
新規 Edge Function `pin-login`（service_role使用・要 verify_jwt 設計）:
1. 入力: store識別子・PIN（オーナー）／キャスト選択・PIN（キャスト）。
2. サーバ側で owner_pin / casts.pin を照合（DBはanonから読めなくする）。
3. 照合OKなら、その店舗・役割に対応する **Supabaseセッション**を発行
   （案A: 店舗/キャスト単位の隠しAuthユーザーへsignIn、案B: カスタムJWT発行）。
4. アプリは以降このセッションで全リクエスト → auth.uid()が立ち、RLSで自店データのみ可。

これにより「PIN」は**サーバ照合される真の秘密**になり、owner_pin等もanonから読めなくなる。

## 4. 段階移行（営業中・ロックアウト回避が最優先）

### Phase 0: 準備（挙動変更なし）
- KYOUKANO用の stores 行 / store_id を用意（or 既存方針決定）。
- pin-login 関数・Authユーザー設計を確定（テスト店舗で先行検証）。

### Phase 1: store_id バックフィル
- 既存 store_id=NULL の全データを KYOUKANO store_id に UPDATE
  （casts, customers, reservations, works, shifts, cast_fees, customer_visits,
   cast_discounts, store_settings, rooms, push_subscriptions, monthly_sales, daily_notes）。
- 影響大のため、メンテ枠で実施・事前バックアップ・件数照合。

### Phase 2: アプリを認証セッション化
- pin-login 経由でサインイン → 全クエリをセッション付きに。
- withStoreFilter / withStoreId を常時 store_id 付与に統一。
- **この時点ではRLSは従来のままなので既存も動く**（anonアクセスはまだ可能）。
- staging + テスト環境で end-to-end 検証。

### Phase 3: RLS厳格化（ここで露出が閉じる）
- `check_store_access`: anon（auth.uid() IS NULL）は **false**（一切不可）に変更。
  ```sql
  -- 変更後
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false               -- 匿名は不可
    ELSE row_store_id = get_my_store_id()             -- 認証ユーザーは自店のみ
  END;
  ```
- **必ず Phase 2 完了・検証後に実施**。ロールバックSQL（旧定義に戻す）を手元に用意。

### Phase 4: 後片付け
- owner_pin をanon可読経路から外す（pin-loginのサーバ側照合のみ）。
- 旧anonコード経路・不要ポリシーを削除。

## 5. リスクと対策
- **ロックアウト**: Phase3を早まると営業中アプリが全停止 → Phase2検証完了が絶対条件。即時revert用SQL常備。
- **データ移行事故**: Phase1は件数照合・バックアップ・1テーブルずつ。
- **セッション管理の複雑化**: 案A/Bの比較検証をテスト店舗で先行。
- 既存テスト環境（本番RLS隔離店舗）で全Phaseを予行演習できる。

## 6. 当面の暫定緩和（移行前にリスクを下げる）
- ✅ notify-line 封鎖済み（9e84960）。
- ☐ LINE_INQUIRY_CHANNEL_SECRET を設定し line-webhook 署名検証を有効化（低リスクだが推奨）。
- ☐ RLS無効テーブル(homepage_shifts 等)にRLS付与 or 限定。
- 注意: anon全開放そのものは移行(Phase3)まで残る。**この課題が解決するまで本番のSaaS公開や
  外部公開はしない**運用を徹底。

## 7. 進め方の推奨
重い設計判断を含むため、着手時は **Opusで設計**。Phaseごとにユーザー承認を取り、
テスト環境で予行→staging→本番の順。1回の作業で全部やらない。
