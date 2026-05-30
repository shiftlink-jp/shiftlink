-- store_settingsにカード決済手数料の設定カラムを追加
-- card_surcharge_rate: お客様への上乗せ率（デフォルト0.1 = 10%）
-- card_fee_rate: カード会社手数料率（デフォルト0.06 = 6%）
-- card_fee_fixed: カード会社手数料固定額（デフォルト80円）
ALTER TABLE store_settings
  ADD COLUMN IF NOT EXISTS card_surcharge_rate numeric(5,4) DEFAULT 0.1,
  ADD COLUMN IF NOT EXISTS card_fee_rate       numeric(5,4) DEFAULT 0.06,
  ADD COLUMN IF NOT EXISTS card_fee_fixed      integer      DEFAULT 80;
