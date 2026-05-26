# ShiftLink マルチテナント設計書

## 概要
ShiftLinkを複数店舗に提供するSaaSとして運用するための設計。
既存の単一店舗アプリを壊さず、段階的にマルチテナント化する。

---

## 1. テナント分離方式

**共有DB + store_id + RLS（Row Level Security）**

- 全テナントが同じSupabaseプロジェクトを共有
- 各テーブルに `store_id` カラムを追加
- RLSポリシーで「自分の店舗のデータだけ見える」を保証
- メリット: 管理が簡単、コスト最小、スケーラブル

---

## 2. 新規テーブル

### stores（shopsテーブルをリネーム or 拡張）
| カラム | 型 | 説明 |
|--------|-----|------|
| id | uuid PK | 店舗ID |
| name | text | 店舗名 |
| slug | text UNIQUE | URL識別子（例: shiftlink.app/kyoukano） |
| owner_email | text | オーナーのメールアドレス |
| owner_user_id | uuid | Supabase Auth の user id |
| plan | text | プラン（free / basic / pro） |
| stripe_customer_id | text | Stripe顧客ID |
| stripe_subscription_id | text | StripeサブスクリプションID |
| subscription_status | text | active / canceled / past_due |
| trial_ends_at | timestamptz | 無料トライアル終了日 |
| created_at | timestamptz | 登録日 |
| settings | jsonb | 店舗設定（現在のstore_settingsを統合） |

### invitations（スタッフ招待）
| カラム | 型 | 説明 |
|--------|-----|------|
| id | uuid PK | |
| store_id | uuid FK→stores | 店舗 |
| email | text | 招待先メール |
| role | text | owner / cast |
| token | text UNIQUE | 招待トークン |
| accepted_at | timestamptz | 承認日（null=未承認） |

---

## 3. 既存テーブルへの変更

全てのテーブルに `store_id uuid REFERENCES stores(id)` を追加する。

| テーブル | 追加カラム | 備考 |
|----------|-----------|------|
| casts | store_id | セラピストは店舗に所属 |
| courses | store_id | コース料金は店舗ごと |
| options | store_id | オプションは店舗ごと |
| customers | store_id | 顧客は店舗ごと |
| customer_memos | store_id | (castsから辿れるが高速化のため) |
| customer_visits | store_id | 同上 |
| shifts | store_id | シフトは店舗ごと |
| reservations | store_id | 予約は店舗ごと |
| works | store_id | 実績は店舗ごと |
| monthly_sales | store_id | 月次売上は店舗ごと |
| cast_fees | store_id | 委託金は店舗ごと |
| cast_discounts | store_id | 割引は店舗ごと |
| daily_notes | store_id | 日報は店舗ごと |
| push_subscriptions | store_id | 通知は店舗ごと |
| notification_logs | store_id | 通知ログは店舗ごと |
| passkeys | store_id | 認証情報は店舗ごと |
| store_settings | store_id | → storesテーブルのsettingsに統合も可 |

**変更不要テーブル:**
- esute_* 系（esute-sync専用、SaaS対象外）
- homepage_shifts（ホームページ同期専用）

---

## 4. 認証フロー

### 現在（PIN認証）
```
アプリ起動 → セラピスト選択 or オーナーPIN入力 → 利用開始
```

### SaaS版（Supabase Auth）
```
アプリ起動 → メール/パスワードログイン → store_id自動判定 → 利用開始
```

### 認証の仕組み
1. **Supabase Auth** でメール/パスワード認証
2. auth.users → stores の紐付けテーブル（store_members）
3. ログイン後、JWTに `store_id` をカスタムクレームとして含める
4. RLSポリシーが `auth.jwt() ->> 'store_id'` で行フィルタ

### store_members テーブル
| カラム | 型 | 説明 |
|--------|-----|------|
| user_id | uuid FK→auth.users | ログインユーザー |
| store_id | uuid FK→stores | 所属店舗 |
| role | text | owner / manager / cast |
| cast_id | integer | castsテーブルのIDと紐付け |

---

## 5. RLSポリシー設計

全テーブル共通パターン:
```sql
-- SELECT: 自分の店舗のデータだけ取得
CREATE POLICY "store_isolation_select" ON テーブル名
  FOR SELECT USING (
    store_id = (
      SELECT store_id FROM store_members
      WHERE user_id = auth.uid()
      LIMIT 1
    )
  );

-- INSERT: 自分の店舗にだけ追加
CREATE POLICY "store_isolation_insert" ON テーブル名
  FOR INSERT WITH CHECK (
    store_id = (
      SELECT store_id FROM store_members
      WHERE user_id = auth.uid()
      LIMIT 1
    )
  );

-- UPDATE/DELETE: 同上
```

---

## 6. 新規店舗オンボーディングフロー

```
1. LP → 「無料で始める」ボタン
2. メール・パスワード・店舗名を入力
3. Supabase Auth でアカウント作成
4. stores テーブルに店舗レコード作成
5. store_members に owner ロールで追加
6. 初期データ作成（デフォルトコース・オプション等）
7. 14日間無料トライアル開始
8. ダッシュボードへリダイレクト
```

---

## 7. Stripe サブスクリプション設計

### プラン案
| プラン | 月額 | 内容 |
|--------|------|------|
| Free | ¥0 | 14日間トライアル |
| Basic | ¥4,980 | セラピスト5名まで、基本機能 |
| Pro | ¥9,800 | セラピスト無制限、全機能、優先サポート |

### Stripe連携フロー
```
1. トライアル終了3日前 → メール通知
2. オーナーがプラン選択 → Stripe Checkout
3. 支払い成功 → webhook → stores.subscription_status = 'active'
4. 毎月自動課金
5. 未払い → stores.subscription_status = 'past_due' → 機能制限
6. 解約 → stores.subscription_status = 'canceled' → 読み取り専用
```

---

## 8. URL設計

### オプションA: サブドメイン方式
```
kyoukano.shiftlink.app  → store_id自動判定
newstore.shiftlink.app  → 別店舗
```

### オプションB: パス方式（推奨・簡単）
```
app.shiftlink.app/kyoukano  → slug で判定
app.shiftlink.app/newstore  → 別店舗
```

### オプションC: ログイン後判定（最も簡単）
```
app.shiftlink.app  → ログイン → store_id自動判定
```
※ 現在のPWAアーキテクチャとの互換性が最も高い

---

## 9. 移行手順（既存データを守る）

### Phase 1: 準備（既存アプリ影響なし）
- [ ] 別ブランチ `feature/saas` で開発
- [ ] 別Supabaseプロジェクトでテスト
- [ ] storesテーブル拡張
- [ ] 全テーブルに store_id カラム追加（NULLable、デフォルト=既存店舗ID）
- [ ] RLSポリシー作成

### Phase 2: 認証切り替え
- [ ] Supabase Auth 設定
- [ ] ログイン画面をメール/パスワードに変更
- [ ] store_members テーブル作成・既存オーナー移行

### Phase 3: Stripe連携
- [ ] Stripe アカウント作成
- [ ] 商品・価格設定
- [ ] Checkout / Webhook 実装
- [ ] トライアル・課金フロー実装

### Phase 4: ローンチ
- [ ] 既存店舗のstore_idを一括設定
- [ ] NOT NULL制約をstore_idに追加
- [ ] 本番環境に反映
- [ ] LPからの新規登録を有効化

---

## 10. 既存アプリとの互換性

### 現在のアプリが壊れない理由
1. store_id は `DEFAULT '既存店舗UUID'` で追加 → 既存データは自動で紐付く
2. 認証は段階的に切り替え → PIN認証を残したまま新認証を追加可能
3. RLSは追加のみ → 既存のanon key動作には影響しない（Phase 2まで）
4. 全開発は別ブランチ＋別Supabaseで行う
