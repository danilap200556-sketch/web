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
];
