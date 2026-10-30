#!/usr/bin/env node
'use strict';
// ТОЛЬКО ДЛЯ РАЗРАБОТКИ: придумывает заказы, клиентов и посещения за последние 60 дней, чтобы в админке было что смотреть.
// Работает только с локальной базой. --reset сначала очищает заказы, клиентов и посещения.
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { Catalog } = require('../src/catalog');
const { createSettings } = require('../src/settings');
const { createDelivery } = require('../src/delivery');
const { newToken } = require('../src/orders');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(20261030);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const wpick = (pairs) => { const sum = pairs.reduce((a, p) => a + p[1], 0); let x = R() * sum; for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; } return pairs[0][0]; };

const MALE = ['Александр', 'Дмитрий', 'Максим', 'Артём', 'Иван', 'Михаил', 'Никита', 'Кирилл', 'Егор', 'Андрей', 'Илья', 'Павел'];
const FEMALE = ['Анна', 'Мария', 'Елена', 'Дарья', 'Алина', 'Ксения', 'Полина', 'Виктория', 'Анастасия', 'София', 'Юлия', 'Ольга'];
const SURNAME = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Соколов', 'Лебедев', 'Козлов', 'Новиков', 'Морозов', 'Петров', 'Волков', 'Соловьёв', 'Васильев', 'Зайцев', 'Павлов', 'Семёнов', 'Голубев', 'Виноградов', 'Богданов', 'Воробьёв'];
const CITIES = [['Москва', 44], ['Санкт-Петербург', 14], ['Казань', 7], ['Екатеринбург', 6], ['Новосибирск', 5], ['Краснодар', 5], ['Нижний Новгород', 4], ['Самара', 3], ['Ростов-на-Дону', 3], ['Воронеж', 2], ['Уфа', 2], ['Пермь', 2]];

function person() {
  const female = R() < 0.46;
  const sn = pick(SURNAME);
  return { name: `${pick(female ? FEMALE : MALE)} ${female ? sn + 'а' : sn}`, phone: '79' + String(Math.floor(R() * 1e9)).padStart(9, '0') };
}

async function main() {
  const cfg = load();
  if (!['localhost', '127.0.0.1'].includes(cfg.db.host)) throw new Error('seed-demo-orders работает только с локальной базой');
  const db = createDb(cfg.db);
  await db.migrate();
  const delivery = createDelivery(db);
  await delivery.ensureDefaults();
  if (process.argv.includes('--reset')) {
    await db.query('TRUNCATE webshop.order_events, webshop.order_items, webshop.orders, webshop.customers, webshop.visits, webshop.carts RESTART IDENTITY CASCADE');
    await db.query('ALTER SEQUENCE webshop.order_number_seq RESTART WITH 10001');
  }
  const catalog = new Catalog(db, cfg, createSettings(db, cfg));
  await catalog.ensure();
  const stocked = catalog.models.filter((m) => m.inStock && m.cover);
  const { methods, points } = await delivery.all();
  const active = methods.filter((m) => m.active);

  // Пул клиентов: часть возвращается за повторной покупкой
  const customers = Array.from({ length: 90 }, person);
  const DAYS = 60;
  const now = Date.now();

  const V = { at: [], kind: [], vid: [], sid: [], path: [], model_key: [], ref_host: [], source: [], device: [] };
  const push = (at, kind, vid, sid, path, key, ref, source, device) => { V.at.push(new Date(at).toISOString()); V.kind.push(kind); V.vid.push(vid); V.sid.push(sid); V.path.push(path); V.model_key.push(key || ''); V.ref_host.push(ref || ''); V.source.push(source || ''); V.device.push(device); };
  const orders = [];
  let visitorSeq = 0;
  const returning = [];

  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(now - d * 86400_000);
    const dow = day.getUTCDay();
    const trend = 1 + (DAYS - d) / DAYS * 0.55;           // посещаемость растёт
    const weekend = dow === 0 || dow === 6 ? 1.18 : 1;
    const base = 105 * trend * weekend * (0.85 + R() * 0.3);
    const visits = Math.round(base);
    for (let i = 0; i < visits; i++) {
      const hour = wpick([[9, 2], [10, 3], [11, 4], [12, 5], [13, 5], [14, 4], [15, 4], [16, 4], [17, 5], [18, 6], [19, 8], [20, 9], [21, 9], [22, 6], [23, 3], [1, 1]]);
      const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - 3, Math.floor(R() * 60), Math.floor(R() * 60));
      if (at > now) continue;
      const isReturning = returning.length > 20 && R() < 0.28;
      const vid = isReturning ? pick(returning) : `v${++visitorSeq}`;
      if (!isReturning) returning.push(vid);
      const sid = `s${d}-${i}`;
      const device = wpick([['mobile', 62], ['desktop', 33], ['tablet', 5]]);
      const source = wpick([['direct', 34], ['search', 31], ['social', 18], ['referral', 11], ['telegram', 4], ['instagram', 2]]);
      const refHost = { search: pick(['yandex.ru', 'google.com', 'ya.ru']), social: pick(['vk.com', 't.me', 'instagram.com']), referral: pick(['sneakerhead.ru', 'pikabu.ru', 'dzen.ru']) }[source] || '';
      push(at, 'page', vid, sid, pick(['/', '/', '/catalog', '/catalog']), '', refHost, source, device);
      let t = at;
      const step = () => (t += 15000 + R() * 90000);
      if (R() < 0.8) push(step(), 'page', vid, sid, '/catalog', '', '', '', device);
      const views = R() < 0.62 ? 1 + Math.floor(R() * R() * 6) : 0;
      let lastModel = null;
      for (let k = 0; k < views; k++) { lastModel = pick(stocked); push(step(), 'product', vid, sid, `/p/${lastModel.slug}`, lastModel.key, '', '', device); }
      if (!views) continue;
      const carted = R() < 0.17;
      if (carted) push(step(), 'cart_add', vid, sid, `/p/${lastModel.slug}`, lastModel.key, '', '', device);
      if (!carted) continue;
      push(step(), 'page', vid, sid, '/cart', '', '', '', device);
      if (R() < 0.62) {
        push(step(), 'checkout', vid, sid, '/checkout', '', '', '', device);
        if (R() < 0.42) {
          push(step(), 'order', vid, sid, '/checkout', '', '', '', device);
          orders.push({ at: t, vid, sid, source, lastModel });
        }
      }
    }
  }
  console.log('Визиты: событий', V.at.length, ', заказов', orders.length);

  // Посещения пачками
  for (let i = 0; i < V.at.length; i += 2000) {
    const s = (a) => a.slice(i, i + 2000);
    await db.query(
      `INSERT INTO webshop.visits (at, kind, vid, sid, path, model_key, ref_host, source, device)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])`,
      [s(V.at), s(V.kind), s(V.vid), s(V.sid), s(V.path), s(V.model_key), s(V.ref_host), s(V.source), s(V.device)]);
  }

  // Заказы: статус зависит от возраста
  let n = 0;
  for (const o of orders) {
    const age = (now - o.at) / 86400_000;
    const cust = R() < 0.3 ? customers[Math.floor(R() * 25)] : pick(customers); // первые 25 - «постоянные»
    const method = wpick(active.map((m) => [m, m.kind === 'pickup' ? 22 : m.kind === 'courier' ? 26 : m.code === 'cdek' ? 30 : 9]));
    const city = method.kind === 'pickup' ? '' : method.kind === 'courier' ? 'Москва' : wpick(CITIES);
    const door = method.kind === 'courier' || (method.kind === 'tc' && R() < 0.4);
    const lines = [];
    const cnt = wpick([[1, 74], [2, 20], [3, 6]]);
    for (let k = 0; k < cnt; k++) {
      const m = k === 0 && o.lastModel && R() < 0.5 ? o.lastModel : pick(stocked);
      const size = pick(m.sizes.filter((s) => s.qty > 0));
      if (size && !lines.find((l) => l.size.id === size.id)) lines.push({ m, size, qty: R() < 0.1 ? 2 : 1 });
    }
    if (!lines.length) continue;
    const subtotal = lines.reduce((a, l) => a + l.size.price * l.qty, 0);
    const price = method.free_from !== null && subtotal >= method.free_from ? 0 : method.price + (door ? method.door_extra : 0);
    const pay = method.kind === 'tc' ? 'online' : R() < 0.45 ? 'cod' : 'online';
    let status;
    if (age > 14) status = wpick([['delivered', 84], ['cancelled', 9], ['returned', 7]]);
    else if (age > 6) status = wpick([['delivered', 62], ['shipped', 24], ['cancelled', 8], ['returned', 6]]);
    else if (age > 3) status = wpick([['shipped', 40], ['packed', 22], ['paid', 20], ['delivered', 10], ['cancelled', 8]]);
    else if (age > 1) status = wpick([['paid', 30], ['confirmed', 28], ['packed', 22], ['new', 14], ['cancelled', 6]]);
    else status = wpick([['new', 55], ['confirmed', 30], ['paid', 15]]);
    const c = await db.query(
      `INSERT INTO webshop.customers (phone, name, email, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET name = webshop.customers.name RETURNING id`,
      [cust.phone, cust.name, R() < 0.55 ? `${cust.phone.slice(-6)}@mail.example` : '', new Date(o.at)]);
    const seq = (await db.query("SELECT nextval('webshop.order_number_seq')::text AS n")).rows[0].n;
    const point = method.kind === 'pickup' ? `${points[0].title}, ${points[0].address}` : !door ? `ПВЗ ${method.title}, ${city}, ул. Ленина, ${Math.floor(R() * 90) + 1}` : '';
    const address = door ? `${city}, ул. ${pick(['Ленина', 'Мира', 'Садовая', 'Гагарина', 'Советская'])}, ${Math.floor(R() * 80) + 1}, кв. ${Math.floor(R() * 120) + 1}` : '';
    const ins = await db.query(
      `INSERT INTO webshop.orders (number, token, customer_id, status, name, phone, email, delivery_code, delivery_title, delivery_kind, delivery_city,
          delivery_address, delivery_point, delivery_door, delivery_cost, pay_method, subtotal, total, vid, sid, source, created_at, updated_at, track_number)
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22) RETURNING id`,
      [seq, newToken(), c.rows[0].id, status, cust.name, cust.phone, method.code, method.title, method.kind, city, address, point, door, price, pay, subtotal, subtotal + price,
        o.vid, o.sid, o.source, new Date(o.at), ['shipped', 'delivered', 'returned'].includes(status) && method.kind === 'tc' ? String(Math.floor(R() * 9e9) + 1e9) : '']);
    const id = ins.rows[0].id;
    for (const l of lines) {
      await db.query(
        `INSERT INTO webshop.order_items (order_id, product_id, sku, model_key, title, type, size, photo_id, price, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, l.size.id, l.size.sku, l.m.key, l.m.title + (l.m.colorway ? ` «${l.m.colorway}»` : ''), l.m.type, l.size.label, l.m.cover, l.size.price, l.qty]);
    }
    await db.query("INSERT INTO webshop.order_events (order_id, at, kind, text) VALUES ($1, $2, 'status', 'Заказ оформлен на сайте')", [id, new Date(o.at)]);
    if (status !== 'new') await db.query("INSERT INTO webshop.order_events (order_id, at, admin_name, kind, text) VALUES ($1, $2, 'Мария', 'status', $3)", [id, new Date(o.at + 25 * 60_000), `Статус: Новый → ${status === 'confirmed' ? 'Подтверждён' : 'Оплачен'}`]);
    n++;
  }
  console.log('Создано заказов:', n);
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
