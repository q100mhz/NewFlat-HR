// Конфигурация сервера из переменных окружения (.env)

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return v.trim();
}

function optional(name: string, def = ''): string {
  return (process.env[name] ?? def).trim();
}

const publicUrl = required('PUBLIC_URL').replace(/\/+$/, '');

export const config = {
  port: Number(optional('PORT', '3000')),
  host: optional('HOST', '0.0.0.0'),
  /** Внешний HTTPS-адрес приложения, например https://hr.example.ru */
  publicUrl,
  databaseUrl: required('DATABASE_URL'),
  /** Ключ шифрования токенов и подписи сессий (минимум 32 символа) */
  secretKey: required('SECRET_KEY'),
  /** Список разрешённых порталов через запятую (example.bitrix24.ru). Пусто — разрешены все. */
  allowedPortals: optional('ALLOWED_PORTALS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  hh: {
    clientId: optional('HH_CLIENT_ID'),
    clientSecret: optional('HH_CLIENT_SECRET'),
    /** hh.ru требует заголовок HH-User-Agent вида "AppName/1.0 (contact@example.ru)" */
    userAgent: optional('HH_USER_AGENT', 'NewFlatHRConnector/1.0 (admin@example.ru)'),
    apiUrl: optional('HH_API_URL', 'https://api.hh.ru'),
    oauthUrl: optional('HH_OAUTH_URL', 'https://hh.ru/oauth/authorize'),
    tokenUrl: optional('HH_TOKEN_URL', 'https://api.hh.ru/token'),
    /** Тип события вебхука hh.ru о новом отклике. Пусто — вебхуки не используются, только опрос. */
    webhookEvent: optional('HH_WEBHOOK_EVENT', 'NEW_NEGOTIATION_VACANCY'),
  },

  b24: {
    oauthUrl: optional('B24_OAUTH_URL', 'https://oauth.bitrix.info/oauth/token/'),
  },

  worker: {
    /** Как часто планировщик проверяет очередь (сек) */
    tickSeconds: Number(optional('WORKER_TICK_SECONDS', '15')),
    maxAttempts: Number(optional('MAX_ATTEMPTS', '8')),
    logRetentionDays: Number(optional('LOG_RETENTION_DAYS', '30')),
  },
};

if (config.secretKey.length < 32) {
  throw new Error('SECRET_KEY должен быть не короче 32 символов');
}
