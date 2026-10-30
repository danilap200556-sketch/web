'use strict';
// Способы доставки и оплаты. Условия (цены, пороги бесплатной доставки, города) лежат в базе и правятся в админке.
const { norm } = require('./catalog');

const TTL = 10_000;

const PAY_METHODS = {
  online: { title: 'Онлайн: картой или по СБП', hint: 'Менеджер пришлёт ссылку на оплату после подтверждения заказа', icon: 'card', needsPrepay: true },
  cod: { title: 'При получении', hint: 'Наличными или картой при самовывозе и от курьера', icon: 'cash', needsPrepay: false },
};

const DEFAULT_METHODS = [
  { code: 'pickup', kind: 'pickup', title: 'Самовывоз из магазина', description: 'Примерьте перед покупкой. Заказ ждёт вас 3 дня', price: 0, door_extra: 0, free_from: null, eta: 'Сегодня, через 2 часа после подтверждения', cities: '', sort: 10 },
  { code: 'courier', kind: 'courier', title: 'Курьер по Москве', description: 'Доставка до двери, можно примерить при курьере', price: 490, door_extra: 0, free_from: 15000, eta: 'На следующий день', cities: 'Москва', sort: 20 },
  { code: 'cdek', kind: 'tc', title: 'СДЭК', description: 'До пункта выдачи или до двери по всей России', price: 390, door_extra: 250, free_from: 20000, eta: '2-6 дней', cities: '', sort: 30 },
  { code: 'boxberry', kind: 'tc', title: 'Boxberry', description: 'До пункта выдачи Boxberry', price: 350, door_extra: 200, free_from: 20000, eta: '3-7 дней', cities: '', sort: 40 },
  { code: 'pochta', kind: 'tc', title: 'Почта России', description: 'В отделение почты, отслеживание по трек-номеру', price: 420, door_extra: 0, free_from: 25000, eta: '5-12 дней', cities: '', sort: 50 },
];

const DEFAULT_POINT = { title: 'Магазин на Примерной', address: 'Москва, ул. Примерная, 1', hours: 'Ежедневно 11:00-21:00', phone: '', sort: 10 };

function createDelivery(db) {
  let cache = null;
  let at = 0;

  async function ensureDefaults() {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM webshop.delivery_methods');
    if (!rows[0].n) {
      for (const m of DEFAULT_METHODS) {
        await db.query(
          `INSERT INTO webshop.delivery_methods (code, kind, title, description, price, door_extra, free_from, eta, cities, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [m.code, m.kind, m.title, m.description, m.price, m.door_extra, m.free_from, m.eta, m.cities, m.sort]);
      }
    }
    const pts = await db.query('SELECT COUNT(*)::int AS n FROM webshop.pickup_points');
    if (!pts.rows[0].n) {
      await db.query('INSERT INTO webshop.pickup_points (title, address, hours, phone, sort) VALUES ($1,$2,$3,$4,$5)',
        [DEFAULT_POINT.title, DEFAULT_POINT.address, DEFAULT_POINT.hours, DEFAULT_POINT.phone, DEFAULT_POINT.sort]);
    }
  }

  async function all() {
    if (cache && Date.now() - at < TTL) return cache;
    const [m, p] = await Promise.all([
      db.query('SELECT * FROM webshop.delivery_methods ORDER BY sort, code'),
      db.query('SELECT * FROM webshop.pickup_points ORDER BY sort, id'),
    ]);
    cache = {
      methods: m.rows.map((r) => ({ ...r, price: Number(r.price), door_extra: Number(r.door_extra), free_from: r.free_from === null ? null : Number(r.free_from) })),
      points: p.rows,
    };
    at = Date.now();
    return cache;
  }

  return { ensureDefaults, all, invalidate: () => { cache = null; } };
}

function quote(m, subtotal, door) {
  const free = m.free_from !== null && subtotal >= m.free_from;
  const price = free ? 0 : m.price + (door ? m.door_extra : 0);
  return { price, free };
}

function cityAllowed(m, city) {
  const list = String(m.cities || '').split(',').map(norm).filter(Boolean);
  return !list.length || list.includes(norm(city));
}

module.exports = { createDelivery, quote, cityAllowed, PAY_METHODS, DEFAULT_METHODS };
