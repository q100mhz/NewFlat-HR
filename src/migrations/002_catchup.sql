-- Догрузка откликов, пропущенных во время сбоя интеграции
ALTER TABLE hh_accounts ADD COLUMN IF NOT EXISTS last_success_at   TIMESTAMPTZ; -- последний полностью успешный опрос
ALTER TABLE hh_accounts ADD COLUMN IF NOT EXISTS last_full_scan_at TIMESTAMPTZ; -- последняя полная сверка
ALTER TABLE hh_accounts ADD COLUMN IF NOT EXISTS catchup_from      TIMESTAMPTZ; -- запрошенная вручную догрузка «с даты»
ALTER TABLE responses   ADD COLUMN IF NOT EXISTS via_catchup       BOOLEAN NOT NULL DEFAULT FALSE;
