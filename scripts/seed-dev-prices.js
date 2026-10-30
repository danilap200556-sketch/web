#!/usr/bin/env node
'use strict';
// ТОЛЬКО ДЛЯ РАЗРАБОТКИ: придумывает цены и скидки сайта (таблица site_prices) для моделей из локальной базы, чтобы было что
// смотреть на витрине и во вкладке «Цены сайта». В боевой базе эти цены задаёт приложение «Склад».
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const APP_SCHEMA = require('./app-schema');
const { splitSku } = require('../src/model');
const { hash } = require('../src/catalog');

(async () => {
  const cfg = load();
  if (!['localhost', '127.0.0.1'].includes(cfg.db.host)) throw new Error('seed-dev-prices работает только с локальной базой');
  const db = createDb(cfg.db);
  for (const q of APP_SCHEMA) await db.query(q);
  await db.query('DELETE FROM site_prices');
  const { rows } = await db.query('SELECT sku, MIN(price)::float8 AS price FROM products WHERE price > 0 GROUP BY sku');
  const base = new Map();
  for (const r of rows) {
    const key = splitSku(r.sku).key;
    if (!base.has(key) || r.price < base.get(key)) base.set(key, r.price);
  }
  const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
  let n = 0, sales = 0;
  for (const [key, wp] of base) {
    const h = Math.abs(hash('site' + key)) % 100;
    if (h >= 72) continue; // у остальных цена сайта не задана - берётся цена склада
    const price = Math.max(990, Math.round((wp * (1.05 + (h % 12) / 40)) / 100) * 100 - 10);
    let sale = null, from = null, to = null;
    if (h % 5 === 0) { // скидка
      const pct = [10, 15, 20, 25, 30, 35][h % 6];
      sale = Math.round((price * (1 - pct / 100)) / 10) * 10;
      const kind = h % 4;
      if (kind === 0) { from = day(-3); to = day(10 + (h % 14)); }   // идёт, с концом
      else if (kind === 1) { from = null; to = null; }                // идёт без срока
      else if (kind === 2) { from = day(5); to = day(20); }           // начнётся позже
      else { from = day(-30); to = day(-5); }                         // закончилась
      sales++;
    }
    await db.query(
      `INSERT INTO site_prices (model_key, price, sale_price, sale_from, sale_to, updated_by) VALUES ($1, $2, $3, $4, $5, 'демо')`,
      [key, price, sale, from, to]);
    n++;
  }
  console.log(`Цены сайта: ${n} моделей из ${base.size}, со скидкой (в т.ч. будущей и прошлой): ${sales}`);
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
