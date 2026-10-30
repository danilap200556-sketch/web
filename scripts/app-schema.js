'use strict';
// Таблицы приложения «Склад», которые читает сайт (копия нужных столбцов из src/database.cpp).
// Нужно только для разработки и тестов: на боевой базе их создаёт приложение.
module.exports = [
  `CREATE TABLE IF NOT EXISTS products (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     sku TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT,
     photo_path TEXT,
     price REAL NOT NULL DEFAULT 0,
     custom_code TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     market_sku TEXT,
     market_vendor TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS warehouses (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     address TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS stock (
     product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
     warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
     location_id INTEGER,
     quantity INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (product_id, warehouse_id)
   )`,
  `CREATE TABLE IF NOT EXISTS product_photos (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     data BYTEA NOT NULL,
     thumb BYTEA NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS product_photos_product_idx ON product_photos (product_id, position, id)',
  // Очередь списания заказов (создаёт приложение «Склад»: списание заказов). Заказ сайта кладёт сюда магазин, списывает кнопка в приложении.
  `CREATE TABLE IF NOT EXISTS order_writeoffs (
     id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     source TEXT NOT NULL,
     account_id INTEGER NOT NULL DEFAULT 0,
     order_ref TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     lines JSONB NOT NULL DEFAULT '[]'::jsonb,
     written JSONB NOT NULL DEFAULT '[]'::jsonb,
     warehouse_id INTEGER,
     doc_id INTEGER,
     return_doc_id INTEGER,
     note TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     written_at TIMESTAMPTZ,
     returned_at TIMESTAMPTZ,
     UNIQUE (source, account_id, order_ref)
   )`,
  // Цены и скидки сайта (ведёт приложение «Склад», вкладка «Цены сайта»)
  `CREATE TABLE IF NOT EXISTS site_prices (
     model_key TEXT PRIMARY KEY,
     price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
     sale_price NUMERIC(12,2) CHECK (sale_price IS NULL OR sale_price >= 0),
     sale_from DATE,
     sale_to DATE,
     updated_by TEXT NOT NULL DEFAULT '',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];
