-- Порталы Битрикс24 (клиенты). Один сервер обслуживает много порталов.
CREATE TABLE IF NOT EXISTS portals (
  id               SERIAL PRIMARY KEY,
  domain           TEXT NOT NULL UNIQUE,
  member_id        TEXT NOT NULL,
  client_id        TEXT,                -- client_id локального приложения в портале
  client_secret    TEXT,                -- зашифровано
  access_token     TEXT,                -- зашифровано
  refresh_token    TEXT,                -- зашифровано
  expires_at       TIMESTAMPTZ,
  client_endpoint  TEXT,
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  hh_client_id     TEXT,                -- своё приложение hh.ru (необязательно)
  hh_client_secret TEXT,                -- зашифровано
  events_bound     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Подключённые аккаунты работодателя hh.ru (менеджеры)
CREATE TABLE IF NOT EXISTS hh_accounts (
  id               SERIAL PRIMARY KEY,
  portal_id        INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
  hh_user_id       TEXT NOT NULL,
  employer_id      TEXT NOT NULL,
  employer_name    TEXT,
  manager_id       TEXT,
  manager_name     TEXT,
  access_token     TEXT NOT NULL,       -- зашифровано
  refresh_token    TEXT NOT NULL,       -- зашифровано
  expires_at       TIMESTAMPTZ,
  import_since     TIMESTAMPTZ NOT NULL DEFAULT now() - interval '1 day',
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_poll_at     TIMESTAMPTZ,
  poll_requested   BOOLEAN NOT NULL DEFAULT TRUE,
  last_error       TEXT,
  webhook_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portal_id, hh_user_id)
);

-- Отклики: одновременно журнал и очередь обработки
CREATE TABLE IF NOT EXISTS responses (
  id                  BIGSERIAL PRIMARY KEY,
  portal_id           INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
  hh_account_id       INTEGER REFERENCES hh_accounts(id) ON DELETE SET NULL,
  negotiation_id      TEXT NOT NULL,
  vacancy_id          TEXT,
  vacancy_name        TEXT,
  resume_id           TEXT,
  candidate_name      TEXT,
  raw                 JSONB,
  hh_created_at       TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending | done | error | skipped
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error          TEXT,
  b24_entity_type_id  INTEGER,
  b24_item_id         BIGINT,
  b24_contact_id      BIGINT,
  b24_stage_id        TEXT,
  is_repeat           BOOLEAN NOT NULL DEFAULT FALSE,
  step                TEXT,            -- последний выполненный шаг (для идемпотентности)
  -- обратная синхронизация в hh.ru
  hh_action           TEXT,
  hh_action_message   TEXT,
  hh_action_attempts  INTEGER NOT NULL DEFAULT 0,
  hh_action_next_at   TIMESTAMPTZ,
  hh_action_error     TEXT,
  hh_last_action      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at         TIMESTAMPTZ,
  UNIQUE (portal_id, negotiation_id)
);
CREATE INDEX IF NOT EXISTS responses_queue_idx ON responses (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS responses_item_idx ON responses (portal_id, b24_entity_type_id, b24_item_id);
CREATE INDEX IF NOT EXISTS responses_action_idx ON responses (hh_action_next_at) WHERE hh_action IS NOT NULL;

-- Журнал событий для экрана «Журнал»
CREATE TABLE IF NOT EXISTS logs (
  id          BIGSERIAL PRIMARY KEY,
  portal_id   INTEGER REFERENCES portals(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,
  message     TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logs_portal_idx ON logs (portal_id, created_at DESC);
