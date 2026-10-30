'use strict';
// Общее для интеграционных тестов: отдельная база, схема склада, магазин на случайном порту, клиент с cookie.
const { Client } = require('pg');
const sharp = require('sharp');
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { createApp } = require('../src/app');
const { bootstrap } = require('../src/bootstrap');
const APP_SCHEMA = require('../scripts/app-schema');
const { hashPassword } = require('../src/security');

const env = (k, d) => process.env[k] || d;
const conn = {
  host: env('TEST_DB_HOST', env('DB_HOST', '127.0.0.1')),
  port: parseInt(env('TEST_DB_PORT', env('DB_PORT', '5432')), 10),
  user: env('TEST_DB_USER', env('DB_USER', 'shop')),
  password: env('TEST_DB_PASSWORD', env('DB_PASSWORD', 'shop')),
};

async function freshDatabase(name) {
  const c = new Client({ ...conn, database: 'postgres' });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  } finally { await c.end(); }
}

async function jpeg(color = '#ffffff') {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toBuffer();
}

// Товар склада: размеры одной модели - отдельные строки с общей частью артикула
async function addProduct(db, { sku, name, price = 10000, qty = 1, photo = true, vendor = '', created }) {
  const { rows } = await db.query(
    'INSERT INTO products (sku, name, description, price, market_vendor, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW())) RETURNING id',
    [sku, name, '', price, vendor, created || null]);
  const id = rows[0].id;
  if (qty) await db.query('INSERT INTO stock (product_id, warehouse_id, quantity) VALUES ($1, 1, $2)', [id, qty]);
  if (photo) {
    const data = await jpeg();
    await db.query('INSERT INTO product_photos (product_id, position, data, thumb) VALUES ($1, 1, $2, $2)', [id, data]);
  }
  return id;
}

async function startShop(suffix, overrides = {}, opts = {}) {
  const name = `webshop_test_${suffix}`;
  await freshDatabase(name);
  const cfg = load({
    DB_HOST: conn.host, DB_PORT: String(conn.port), DB_USER: conn.user, DB_PASSWORD: conn.password, DB_NAME: name, DB_SSL: 'disable',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-test', COOKIE_SECURE: 'false', CATALOG_TTL: '0',
    ADMIN_USER: 'owner1', ADMIN_PASSWORD: 'owner-pass-123', ...overrides,
  });
  const db = createDb(cfg.db);
  for (const q of APP_SCHEMA) if ((opts.sitePrices !== false || !/site_prices/.test(q)) && (opts.queue !== false || !/order_writeoffs/.test(q))) await db.query(q);
  await db.query("INSERT INTO warehouses (name) VALUES ('Основной')");
  await db.migrate();
  const app = createApp(cfg, db);
  await bootstrap(app.locals.services);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const services = app.locals.services;
  return {
    cfg, db, app, base, services, name,
    async stop() { await app.locals.shutdown(); await new Promise((r) => server.close(r)); await db.end(); },
  };
}

// HTTP-клиент с cookie и без автоматических переходов
function client(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function request(method, path, { form, headers = {}, ua = 'Mozilla/5.0 (X11; Linux) Chrome/120 Safari/537.36' } = {}) {
    const h = { 'user-agent': ua, ...headers };
    if (jar.size) h.cookie = cookieHeader();
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/;\s*Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }
  return { get: (p, o) => request('GET', p, o), post: (p, form, o) => request('POST', p, { ...o, form }), jar };
}

// Цена сайта (в боевой базе её задаёт приложение «Склад»): sale/from/to необязательны, даты 'YYYY-MM-DD'
async function addSitePrice(db, key, { price, sale = null, from = null, to = null }) {
  await db.query('INSERT INTO site_prices (model_key, price, sale_price, sale_from, sale_to) VALUES ($1, $2, $3, $4, $5)', [key, price, sale, from, to]);
}
// Дата со сдвигом в днях в часовом поясе магазина (как считает сайт)
function ymd(offsetDays = 0, tz = 'Europe/Moscow') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() + offsetDays * 86400_000));
}

async function addAdmin(db, username, role, password = 'pass-12345') {
  await db.query('INSERT INTO webshop.admin_users (username, display_name, password_hash, role) VALUES ($1, $1, $2, $3)', [username, hashPassword(password), role]);
  return password;
}

// Вход в админку; возвращает клиента с сессией и csrf-токеном (достаётся со страницы)
async function adminLogin(base, username, password) {
  const c = client(base);
  const r = await c.post('/admin/login', { username, password });
  if (r.status !== 302) throw new Error(`вход не удался: ${r.status}`);
  const page = await c.get('/admin/account');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] || '';
  return { c, csrf };
}

module.exports = { startShop, client, addProduct, addSitePrice, ymd, addAdmin, adminLogin, jpeg };
