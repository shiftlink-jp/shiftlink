-- 034_reservation_copy_message.sql
-- 「お客様用 予約確認URLをコピー」を押したとき、URLと一緒にコピーされる文章（LINE等に貼る本文）。
-- 例:「KYOUKANO NAGOYAです。ご予約ありがとうございます。下記より内容をご確認ください。{URL}」
--
-- この列が無くてもアプリは動く（アプリ側の既定文が使われる）。
-- 列を追加すると、店舗設定の「LINEに貼り付ける文章」から店舗ごとに書き換えられるようになる。
-- 既存挙動には影響しない（NULL許容の追加カラム）。
--
-- 適用先: KYOUKANO本番(qgcgkrcrfzonmmygcdju) / SaaS開発(fewuonnrgqnxtopkjudt)

ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS public_copy_message text;
