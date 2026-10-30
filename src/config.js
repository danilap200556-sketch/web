'use strict';
const crypto = require('crypto');

function intEnv(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function load(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  let secret = env.SESSION_SECRET;
  if (!secret) {
    if (prod) throw new Error('SESSION_SECRET не задан (нужна случайная строка от 32 символов)');
    secret = crypto.randomBytes(32).toString('hex');
  }
  if (secret.length < 32) throw new Error('SESSION_SECRET слишком короткий (нужно от 32 символов)');

  const ssl = (env.DB_SSL || 'require').toLowerCase();
  if (!['require', 'verify', 'disable'].includes(ssl)) throw new Error('DB_SSL должен быть require, verify или disable');

  return {
    prod,
    port: intEnv(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    secret,
    // Cookie только по HTTPS. На проде по умолчанию включено; для проверки по http: COOKIE_SECURE=false.
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE !== 'false' : prod,
    // Сколько прокси стоит перед сайтом (в docker-compose это Caddy - 1).
    trustProxy: intEnv(env.TRUST_PROXY, 0),
    sessionHours: intEnv(env.SESSION_HOURS, 12),
    // Публичный адрес сайта (для sitemap и ссылок в письмах), без слэша на конце.
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Название магазина по умолчанию; потом меняется в админке («Настройки»).
    shopName: env.SHOP_NAME || 'SOLEHOUSE',
    tz: env.DISPLAY_TZ || 'Europe/Moscow',
    // Первый владелец админки создаётся при запуске, если админов ещё нет.
    bootstrapAdmin: env.ADMIN_USER && env.ADMIN_PASSWORD ? { username: env.ADMIN_USER, password: env.ADMIN_PASSWORD } : null,
    // Как долго держать кэш каталога в памяти (сек): товары и остатки правятся в приложении, сайт подхватывает сам.
    catalogTtl: intEnv(env.CATALOG_TTL, 30),
    // Уведомления о новых заказах в Telegram: токен бота (@BotFather) и один или несколько чатов через запятую (число или @канал).
    // Расчёт доставки по API. СДЭК: ключи интеграции из личного кабинета (Интеграция -> Ключи API), откуда отправляем и как.
    // Размеры и вес одной коробки с парой - для расчёта тарифа (в посылке они складываются по числу пар).
    carriers: {
      cdek: {
        account: (env.CDEK_ACCOUNT || '').trim(),
        secret: (env.CDEK_SECURE || '').trim(),
        baseUrl: (env.CDEK_API_URL || 'https://api.cdek.ru').replace(/\/+$/, ''),
        fromCode: intEnv(env.CDEK_FROM_CODE, 0),
        fromCity: (env.CDEK_FROM_CITY || '').trim(),
        fromMode: env.CDEK_FROM_MODE === 'door' ? 'door' : 'office',
      },
      parcel: {
        weightG: intEnv(env.PARCEL_WEIGHT_G, 1500),
        length: intEnv(env.PARCEL_LENGTH_CM, 34),
        width: intEnv(env.PARCEL_WIDTH_CM, 22),
        height: intEnv(env.PARCEL_HEIGHT_CM, 14),
      },
    },
    notify: {
      telegramToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
      telegramChatIds: (env.TELEGRAM_CHAT_ID || '').split(/[\s,;]+/).filter(Boolean),
      telegramApi: (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, ''),
    },
    db: {
      host: env.DB_HOST || 'localhost',
      port: intEnv(env.DB_PORT, 5432),
      database: env.DB_NAME || 'postgres',
      user: env.DB_USER || 'postgres',
      password: env.DB_PASSWORD || '',
      ssl,
      sslCaFile: env.DB_SSL_CA || '',
      poolSize: intEnv(env.DB_POOL, 8),
    },
  };
}

module.exports = { load };
