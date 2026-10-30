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
];

module.exports = { SCHEMA };
