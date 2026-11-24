'use strict';
// Общее для интеграционных тестов: отдельная база, схема склада, магазин на случайном порту, клиент с cookie.
const http = require('node:http');
const assert = require('node:assert/strict');
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
async function addProduct(db, { sku, name, price = 10000, qty = 1, photo = true, vendor = '', category = '', created }) {
  const { rows } = await db.query(
    'INSERT INTO products (sku, name, description, price, market_vendor, market_category_name, created_at) VALUES ($1, $2, $3, $4, $5, $7, COALESCE($6, NOW())) RETURNING id',
    [sku, name, '', price, vendor, created || null, category]);
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
  const app = createApp(cfg, db, opts.app || {});
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

// Поддельный SMS.ru: запоминает отправленное, ответ можно переключить (mode.fail - ответ с ошибкой, mode.http - код ответа)
async function fakeSmsRu() {
  const calls = [];
  const mode = { fail: false, http: 200 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/sms/send') { res.writeHead(404); return res.end(); }
    const call = { apiId: u.searchParams.get('api_id'), to: u.searchParams.get('to'), msg: u.searchParams.get('msg'), from: u.searchParams.get('from') };
    calls.push(call);
    res.writeHead(mode.http, { 'content-type': 'application/json' });
    if (mode.http !== 200) return res.end('{}');
    if (mode.fail) return res.end(JSON.stringify({ status: 'ERROR', status_code: 200, status_text: 'Неправильный api_id' }));
    res.end(JSON.stringify({ status: 'OK', status_code: 100, sms: { [call.to]: { status: 'OK', status_code: 100, sms_id: `000000-${calls.length}` } }, balance: 100 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, mode, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Поддельный Telegram Bot API: запоминает запросы (calls), отдаёт очередь обновлений (updates) на getUpdates,
// ответ можно переключать: mode.fail (число ответов 500), mode.body/status (свой ответ), mode.conflict (409 на getUpdates),
// mode.blocked (чаты, где бот заблокирован: 403).
async function fakeTelegram() {
  const calls = [];
  const updates = [];
  const mode = { fail: 0, status: 200, body: null, conflict: false, blocked: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url, body });
      const method = req.url.split('/').pop();
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (method === 'getMe') return json(200, { ok: true, result: { id: 1, is_bot: true, username: 'solehouse_test_bot' } });
      if (method === 'getUpdates') {
        if (mode.conflict) return json(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
        return json(200, { ok: true, result: updates.splice(0) });
      }
      if (mode.blocked.has(String(body.chat_id))) return json(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      if (mode.fail > 0) { mode.fail--; return json(500, { ok: false, description: 'Internal Server Error' }); }
      if (mode.body) return json(mode.status, mode.body);
      json(200, { ok: true, result: { message_id: calls.length } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, updates, mode, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Покупатель уже вошёл: подтверждённый клиент, сессия, cookie в клиенте. fresh - сессия «по коду» (15 минут можно менять пароль без старого).
async function loginAs(shop, c, phone, { name = 'Тест', fresh = false } = {}) {
  const { accounts, sessions } = shop.services;
  const { customer } = await accounts.ensureByVerifiedPhone(phone, { name });
  const token = await sessions.create(customer.id, { ip: '127.0.0.1', ua: 'test', fresh });
  c.jar.set(sessions.cookieName, token);
  return customer;
}

let placeSeq = 0;
// Оформляет заказ самовывозом с оплатой при получении (c - клиент с cookie, чтобы заказывать вошедшим; pid - один товар или список)
async function placeOrder(shop, pid, { phone = '89160000001', qty = 1, comment = '', c = client(shop.base), delivery = 'pickup', name = 'Анна' } = {}) {
  await c.get('/');
  for (const p of [].concat(pid)) for (let i = 0; i < qty; i++) await c.post('/cart/add', { pid: p });
  const co = (await c.get('/checkout')).text;
  // Сайт ограничивает число заказов с одного адреса; при TRUST_PROXY каждому заказу даём «свой» адрес
  const h = shop.cfg.trustProxy ? { headers: { 'x-forwarded-for': `10.9.${(++placeSeq >> 8) & 255}.${placeSeq & 255}` } } : {};
  const r = await c.post('/checkout', {
    idem: /name="idem" value="([^"]+)"/.exec(co)[1], name, phone, delivery,
    point: /name="point" value="(\d+)"/.exec(co)[1], pay: 'cod', consent: '1', comment,
  }, h);
  assert.equal(r.status, 303, r.text.slice(0, 200));
  const number = /\/order\/(\d+)/.exec(r.location)[1];
  const orderId = (await shop.db.query('SELECT id FROM webshop.orders WHERE number = $1', [number])).rows[0].id;
  return { number, orderId, location: r.location, c };
}

module.exports = { placeOrder, loginAs, fakeTelegram, fakeSmsRu, startShop, client, addProduct, addSitePrice, ymd, addAdmin, adminLogin, jpeg };
