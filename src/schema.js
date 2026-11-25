'use strict';
// Таблицы магазина (схема `webshop`). Список только дополняется: номер ревизии - число операторов,
// на каждом запуске выполняются лишь новые. Изменить уже выпущенный оператор нельзя - добавьте следующий.
const SCHEMA = [
  // --- Настройки магазина (название, контакты, режим сезонной витрины...) ---
  `CREATE TABLE IF NOT EXISTS webshop.settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL DEFAULT '{}',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // --- Администраторы сайта: свои учётные записи, не связаны с пользователями приложения «Склад» ---
  `CREATE TABLE IF NOT EXISTS webshop.admin_users (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('owner', 'manager', 'editor')),
     active BOOLEAN NOT NULL DEFAULT TRUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_login_at TIMESTAMPTZ
   )`,
  // --- Покупатели: одна запись на телефон ---
  `CREATE TABLE IF NOT EXISTS webshop.customers (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     phone TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL DEFAULT '',
     email TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // --- Способы доставки: самовывоз, курьер, транспортные компании ---
  `CREATE TABLE IF NOT EXISTS webshop.delivery_methods (
     code TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('pickup', 'courier', 'tc')),
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     price NUMERIC(10,2) NOT NULL DEFAULT 0,
     door_extra NUMERIC(10,2) NOT NULL DEFAULT 0,
     free_from NUMERIC(12,2),
     eta TEXT NOT NULL DEFAULT '',
     cities TEXT NOT NULL DEFAULT '',
     active BOOLEAN NOT NULL DEFAULT TRUE,
     sort INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS webshop.pickup_points (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     title TEXT NOT NULL,
     address TEXT NOT NULL DEFAULT '',
     hours TEXT NOT NULL DEFAULT '',
     phone TEXT NOT NULL DEFAULT '',
     active BOOLEAN NOT NULL DEFAULT TRUE,
     sort INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE SEQUENCE IF NOT EXISTS webshop.order_number_seq START 10001`,
  // --- Заказы ---
  `CREATE TABLE IF NOT EXISTS webshop.orders (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     token TEXT NOT NULL,
     idem_key TEXT UNIQUE,
     customer_id INTEGER REFERENCES webshop.customers(id),
     status TEXT NOT NULL DEFAULT 'new',
     name TEXT NOT NULL,
     phone TEXT NOT NULL,
     email TEXT NOT NULL DEFAULT '',
     delivery_code TEXT NOT NULL,
     delivery_title TEXT NOT NULL,
     delivery_kind TEXT NOT NULL,
     delivery_city TEXT NOT NULL DEFAULT '',
     delivery_address TEXT NOT NULL DEFAULT '',
     delivery_point TEXT NOT NULL DEFAULT '',
     delivery_door BOOLEAN NOT NULL DEFAULT FALSE,
     delivery_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
     pay_method TEXT NOT NULL,
     subtotal NUMERIC(12,2) NOT NULL,
     total NUMERIC(12,2) NOT NULL,
     comment TEXT NOT NULL DEFAULT '',
     track_number TEXT NOT NULL DEFAULT '',
     vid TEXT NOT NULL DEFAULT '',
     sid TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS orders_created_idx ON webshop.orders (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON webshop.orders (status)`,
  `CREATE INDEX IF NOT EXISTS orders_customer_idx ON webshop.orders (customer_id)`,
  `CREATE TABLE IF NOT EXISTS webshop.order_items (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     order_id INTEGER NOT NULL REFERENCES webshop.orders(id) ON DELETE CASCADE,
     product_id INTEGER,
     sku TEXT NOT NULL,
     model_key TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL,
     type TEXT NOT NULL DEFAULT '',
     size TEXT NOT NULL DEFAULT '',
     photo_id INTEGER,
     price NUMERIC(12,2) NOT NULL,
     qty INTEGER NOT NULL CHECK (qty > 0)
   )`,
  `CREATE INDEX IF NOT EXISTS order_items_order_idx ON webshop.order_items (order_id)`,
  `CREATE INDEX IF NOT EXISTS order_items_product_idx ON webshop.order_items (product_id)`,
  // История заказа: смены статуса, заметки менеджера
  `CREATE TABLE IF NOT EXISTS webshop.order_events (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     order_id INTEGER NOT NULL REFERENCES webshop.orders(id) ON DELETE CASCADE,
     at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     admin_name TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'note',
     text TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS order_events_order_idx ON webshop.order_events (order_id, at)`,
  // Корзины хранятся на сервере, в браузере - только случайный ключ
  `CREATE TABLE IF NOT EXISTS webshop.carts (
     token TEXT PRIMARY KEY,
     items JSONB NOT NULL DEFAULT '[]',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Посещения и действия: page - просмотр страницы, product - карточка модели, cart_add - в корзину,
  // checkout - открыто оформление, order - заказ оформлен. vid - посетитель (cookie на год),
  // sid - визит (cookie на 30 минут без активности).
  `CREATE TABLE IF NOT EXISTS webshop.visits (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     kind TEXT NOT NULL DEFAULT 'page',
     vid TEXT NOT NULL,
     sid TEXT NOT NULL,
     path TEXT NOT NULL DEFAULT '',
     model_key TEXT NOT NULL DEFAULT '',
     ref_host TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     device TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS visits_at_idx ON webshop.visits (at)`,
  `CREATE INDEX IF NOT EXISTS visits_kind_at_idx ON webshop.visits (kind, at)`,
  // Пометки моделей: скрыть с сайта, показать первыми, свой ярлык («Хит», «Новинка»)
  `CREATE TABLE IF NOT EXISTS webshop.model_flags (
     model_key TEXT PRIMARY KEY,
     hidden BOOLEAN NOT NULL DEFAULT FALSE,
     featured BOOLEAN NOT NULL DEFAULT FALSE,
     badge TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Очередь уведомлений (Telegram): строку кладёт заказ в своей транзакции, отправляет фоновый процесс с повторами
  `CREATE TABLE IF NOT EXISTS webshop.outbox (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     kind TEXT NOT NULL,
     order_id INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     attempts INTEGER NOT NULL DEFAULT 0,
     sent_at TIMESTAMPTZ,
     error TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS outbox_due_idx ON webshop.outbox (next_at) WHERE sent_at IS NULL`,
  // Данные расчёта доставки по API (перевозчик, код города и пункта выдачи, тариф, срок): пригодятся при оформлении отправки
  `ALTER TABLE webshop.orders ADD COLUMN IF NOT EXISTS delivery_meta JSONB`,
  // Платежи через эквайринг (карта онлайн): одна запись на попытку оплаты, статус приходит уведомлением банка
  `CREATE TABLE IF NOT EXISTS webshop.payments (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     order_id INTEGER NOT NULL,
     provider TEXT NOT NULL,
     provider_order_id TEXT NOT NULL,
     provider_payment_id TEXT NOT NULL DEFAULT '',
     amount NUMERIC(12,2) NOT NULL,
     status TEXT NOT NULL DEFAULT 'new',
     url TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Каталог электроники партнёра (Sergeev Electronics): ассортимент, цены, наличие и фото подтягивает фоновая синхронизация
  `CREATE TABLE IF NOT EXISTS webshop.ext_products (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     source TEXT NOT NULL,
     path TEXT NOT NULL,
     section TEXT NOT NULL DEFAULT '',
     title TEXT NOT NULL,
     brand TEXT NOT NULL DEFAULT '',
     sku TEXT NOT NULL DEFAULT '',
     price NUMERIC(12,2) NOT NULL DEFAULT 0,
     old_price NUMERIC(12,2),
     in_stock BOOLEAN NOT NULL DEFAULT TRUE,
     images JSONB NOT NULL DEFAULT '[]'::jsonb,
     description TEXT NOT NULL DEFAULT '',
     detail_at TIMESTAMPTZ,
     seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (source, path)
   )`,
  `CREATE INDEX IF NOT EXISTS payments_order_idx ON webshop.payments (order_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_uq ON webshop.payments (provider, provider_payment_id) WHERE provider_payment_id <> ''`,
  // --- Фон первого экрана главной: своё видео или фото из админки (хранится одна запись - текущий фон) ---
  `CREATE TABLE IF NOT EXISTS webshop.hero_media (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('video', 'image')),
     mime TEXT NOT NULL,
     data BYTEA NOT NULL,
     size INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // --- Личный кабинет покупателя: подтверждённый телефон как идентичность, пароль, Telegram, личная скидка ---
  `ALTER TABLE webshop.customers
     ADD COLUMN IF NOT EXISTS password_hash TEXT,
     ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS telegram_id BIGINT,
     ADD COLUMN IF NOT EXISTS tg_notify BOOLEAN NOT NULL DEFAULT TRUE,
     ADD COLUMN IF NOT EXISTS personal_discount NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (personal_discount BETWEEN 0 AND 100),
     ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_tg_uq ON webshop.customers (telegram_id) WHERE telegram_id IS NOT NULL`,
  // Почта как логин уникальна только среди аккаунтов с паролем (у остальных это просто контакт из заказа)
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_email_login_uq ON webshop.customers (lower(email)) WHERE password_hash IS NOT NULL AND email <> ''`,
  // Сессии покупателей: в cookie случайный токен, здесь только его sha256
  `CREATE TABLE IF NOT EXISTS webshop.customer_sessions (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     customer_id INTEGER NOT NULL REFERENCES webshop.customers(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     fresh_until TIMESTAMPTZ,
     ip TEXT NOT NULL DEFAULT '',
     ua TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON webshop.customer_sessions (customer_id)`,
  // Одноразовые коды и токены (SMS, Telegram, ссылки из писем): хранится только HMAC
  `CREATE TABLE IF NOT EXISTS webshop.auth_codes (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     purpose TEXT NOT NULL,
     channel TEXT NOT NULL,
     target TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ,
     ip TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS auth_codes_target_idx ON webshop.auth_codes (purpose, target, created_at)`,
  `CREATE INDEX IF NOT EXISTS auth_codes_channel_idx ON webshop.auth_codes (channel, created_at)`,
  // Вход и привязка через Telegram-бота: ссылка-токен, затем телефон и telegram_id из контакта
  `CREATE TABLE IF NOT EXISTS webshop.tg_login (
     token TEXT PRIMARY KEY,
     purpose TEXT NOT NULL,
     customer_id INTEGER,
     phone TEXT,
     telegram_id BIGINT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     consumed_at TIMESTAMPTZ
   )`,
  // Сообщения покупателям (статус заказа) несут данные в payload; скидка лояльности хранится в заказе
  `ALTER TABLE webshop.outbox ADD COLUMN IF NOT EXISTS payload TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE webshop.orders
     ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS discount_note TEXT NOT NULL DEFAULT ''`,
  // --- Логотип сайта из админки: исходник и готовые варианты (для светлого и тёмного фона, значок вкладки); хранится одна запись ---
  `CREATE TABLE IF NOT EXISTS webshop.site_logo (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     mono BOOLEAN NOT NULL,
     original BYTEA NOT NULL,
     dark BYTEA NOT NULL,
     light BYTEA NOT NULL,
     icon BYTEA NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // --- Текстовые страницы из админки («О нас», соглашение, политика, FAQ): ссылки в подвале, колонка «Информация» ---
  `CREATE TABLE IF NOT EXISTS webshop.pages (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     published BOOLEAN NOT NULL DEFAULT FALSE,
     in_footer BOOLEAN NOT NULL DEFAULT TRUE,
     sort INTEGER NOT NULL DEFAULT 100,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Ручные цены на электронику: закупка вручную, наценка товара и цена на сайте задаются в админке («Электроника» -> «Таблица цен»)
  `CREATE TABLE IF NOT EXISTS webshop.ext_prices (
     ext_id INTEGER PRIMARY KEY REFERENCES webshop.ext_products(id) ON DELETE CASCADE,
     buy_price NUMERIC(12,2) CHECK (buy_price IS NULL OR buy_price >= 0),
     markup_pct NUMERIC(6,2) CHECK (markup_pct IS NULL OR markup_pct BETWEEN 0 AND 300),
     manual_price NUMERIC(12,2) CHECK (manual_price IS NULL OR manual_price >= 0),
     updated_by TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Своё описание модели из админки («Витрина и каталог»): пусто - описание из склада
  `ALTER TABLE webshop.model_flags ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
];

module.exports = { SCHEMA };
