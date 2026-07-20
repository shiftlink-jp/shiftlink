-- 022_reservation_public_greeting.sql
-- 予約確認URL(公開ページ)の先頭に表示する挨拶文。店舗設定で自由に編集できる。
-- 例: 「KYOUKANO NAGOYAです。この度はご予約ありがとうございます。」
-- 既存挙動には影響しない（NULL許容の追加カラム）。

ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS public_greeting text;
