-- ルームに最寄り駐車場を設定できるようにする（予約確認URLに表示）
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS parking text;
