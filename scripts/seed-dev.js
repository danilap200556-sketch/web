#!/usr/bin/env node
'use strict';
// Заполняет БЕЗ БОЕВЫХ ДАННЫХ локальную базу для разработки: таблицы склада + товары из выгрузки Excel
// (колонки «Артикул», «Название», «Фото 1..4» - как в «Фото из Excel» приложения), цены и остатки
// придумываются. Фото скачиваются по ссылкам из файла.
//
//   DB_HOST=127.0.0.1 DB_NAME=sklad DB_USER=shop DB_PASSWORD=shop DB_SSL=disable \
//     node scripts/seed-dev.js photo_links.xlsx [--photos=120]
//
// Скачанные фото чужие и нужны только для проверки внешнего вида на вашем компьютере.
const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');
const sharp = require('sharp');
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const APP_SCHEMA = require('./app-schema');
const { splitSku, parseName } = require('../src/model');
const { hash } = require('../src/catalog');

function readXlsx(file) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const rows = [];
  for (const m of sheet.matchAll(/<row [^>]*>(.*?)<\/row>/gs)) {
    const row = {};
    for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/gs)) {
      row[c[1]] = unesc((c[2] || '').replace(/<[^>]+>/g, ''));
    }
    rows.push(row);
  }
  const head = rows.shift();
  return rows.map((r) => {
    const o = { sku: r.A || '', name: r.B || '', photos: [] };
    for (const [col, title] of Object.entries(head)) if (/^фото/i.test(title) && r[col]) o.photos.push(r[col]);
    return o;
  });
}

// Цена по типу и бренду, ступеньки по 100 ₽ с окончанием на 90
function priceFor(name, key) {
  const p = parseName(name);
  let base = 9990;
  const t = p.type.toLowerCase();
  if (t === 'кроссовки' || t === 'кеды') base = 10990;
  if (/ботинки|угги/.test(t)) base = 17990;
  if (/шл[её]панцы|слайды|сабо|мюли|тапочки/.test(t)) base = 4990;
  if (/куртка|пуховик/.test(t)) base = 24990;
  if (/худи|свитшот|толстовка|лонгслив/.test(t)) base = 8990;
  if (/футболка|шорты|кепка/.test(t)) base = 3990;
  if (/сумка|рюкзак/.test(t)) base = 12990;
  const boost = { Nike: 1.1, 'New Balance': 1.2, adidas: 1.0, Jordan: 1.6, "Arc'teryx": 2.4, 'Stone Island': 2.2, Dior: 6, Messika: 12, Longchamp: 1.5, UGG: 1.3, On: 1.5 }[p.brand] || 1;
  const jitter = 0.8 + (Math.abs(hash(key)) % 60) / 100;
  return Math.max(990, Math.round((base * boost * jitter) / 100) * 100 - 10);
}

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (dev seed)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

async function prepare(buf) {
  const data = await sharp(buf, { limitInputPixels: 60_000_000 }).rotate().flatten({ background: '#ffffff' })
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const thumb = await sharp(data).resize(240, 240, { fit: 'inside' }).jpeg({ quality: 78 }).toBuffer();
  return { data, thumb };
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Использование: node scripts/seed-dev.js выгрузка.xlsx [--photos=N]'); process.exit(2); }
  const limit = parseInt((process.argv.find((a) => a.startsWith('--photos=')) || '--photos=100000').split('=')[1], 10);
  const cfg = load();
  if (cfg.db.host !== 'localhost' && cfg.db.host !== '127.0.0.1') throw new Error('seed-dev работает только с локальной базой (DB_HOST=127.0.0.1)');
  const db = createDb(cfg.db);
  for (const q of APP_SCHEMA) await db.query(q);
  await db.migrate();
  const rows = readXlsx(file).filter((r) => r.sku && r.name);
  console.log('Строк в выгрузке:', rows.length);

  await db.query("INSERT INTO warehouses (name) VALUES ('Основной склад'), ('Магазин') ON CONFLICT DO NOTHING");
  const wh = (await db.query('SELECT id FROM warehouses ORDER BY id')).rows.map((r) => r.id);

  // Товары и остатки
  const created = Date.now();
  const byModel = new Map();
  for (const r of rows) {
    const { key } = splitSku(r.sku);
    const age = (Math.abs(hash('age' + key)) % 150) * 86400_000;
    const price = priceFor(r.name, key);
    const ins = await db.query(
      `INSERT INTO products (sku, name, description, price, created_at) VALUES ($1, $2, '', $3, $4)
       ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [r.sku, r.name, price, new Date(created - age)]);
    const id = ins.rows[0].id;
    const h = Math.abs(hash(r.sku)) % 100;
    const qty = h < 35 ? 0 : h < 65 ? 1 : h < 85 ? 2 : 3 + (h % 3);
    if (qty) await db.query('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, wh[h % wh.length], qty]);
    if (!byModel.has(key)) byModel.set(key, { id, photos: r.photos });
    else if (!byModel.get(key).photos.length && r.photos.length) byModel.get(key).photos = r.photos;
  }
  console.log('Моделей:', byModel.size);

  // Фото: у реального приложения они лежат у каждого размера; для разработки достаточно одного
  const todo = [...byModel.values()].filter((m) => m.photos.length).slice(0, limit);
  let done = 0, failed = 0, idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const m = todo[idx++];
      const have = await db.query('SELECT 1 FROM product_photos WHERE product_id = $1 LIMIT 1', [m.id]);
      if (have.rowCount) { done++; continue; }
      let pos = 0;
      for (const url of m.photos.slice(0, 3)) {
        try {
          const p = await prepare(await download(url));
          await db.query('INSERT INTO product_photos (product_id, position, data, thumb) VALUES ($1, $2, $3, $4)', [m.id, ++pos, p.data, p.thumb]);
        } catch (e) { failed++; }
      }
      if (++done % 25 === 0) console.log(`  фото: ${done}/${todo.length} моделей`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`Готово: моделей с фото ${todo.length}, не скачалось ссылок ${failed}`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
