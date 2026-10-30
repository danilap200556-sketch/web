'use strict';
// Выборки для сводки и статистики. Все периоды считаются по календарным дням в часовом поясе магазина.
const { REVENUE_STATUSES } = require('../orders');

const RANGES = { '1': 'Сегодня', '7': '7 дней', '30': '30 дней', '90': '90 дней' };
const NOT_VALID = ['cancelled', 'returned'];

function parseRange(v) {
  return RANGES[String(v)] ? parseInt(v, 10) : 30;
}

// Границы периода и такого же предыдущего: { lo, hi, plo, days, labels: ['2026-10-01', ...] }
async function bounds(db, tz, days) {
  const { rows } = await db.query(
    `SELECT lo, lo + make_interval(days => $2) AS hi, lo - make_interval(days => $2) AS plo,
            to_char(lo AT TIME ZONE $1, 'YYYY-MM-DD') AS first_day
       FROM (SELECT (date_trunc('day', NOW() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AT TIME ZONE $1 AS lo) t`, [tz, days]);
  const r = rows[0];
  const labels = [];
  const [y, m, d] = r.first_day.split('-').map(Number);
  for (let i = 0; i < days; i++) labels.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  return { lo: r.lo, hi: r.hi, plo: r.plo, days, labels };
}

const num = (v) => Number(v) || 0;

async function kpis(db, lo, hi) {
  const [o, v, c] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE status <> ALL($3))::int AS valid,
              COALESCE(SUM(total) FILTER (WHERE status <> ALL($3)), 0) AS revenue,
              COUNT(*) FILTER (WHERE status = ANY($3))::int AS cancelled,
              COUNT(DISTINCT customer_id)::int AS buyers
         FROM webshop.orders WHERE created_at >= $1 AND created_at < $2`, [lo, hi, NOT_VALID]),
    db.query(
      `SELECT COUNT(DISTINCT sid)::int AS visits, COUNT(DISTINCT vid)::int AS uniques,
              COUNT(*) FILTER (WHERE kind IN ('page', 'product'))::int AS views
         FROM webshop.visits WHERE at >= $1 AND at < $2`, [lo, hi]),
    db.query('SELECT COUNT(*)::int AS n FROM webshop.customers WHERE created_at >= $1 AND created_at < $2', [lo, hi]),
  ]);
  const a = o.rows[0];
  const valid = a.valid;
  return {
    orders: a.orders, valid, revenue: num(a.revenue), avg: valid ? num(a.revenue) / valid : 0, cancelled: a.cancelled, buyers: a.buyers,
    visits: v.rows[0].visits, uniques: v.rows[0].uniques, views: v.rows[0].views, newCustomers: c.rows[0].n,
    conversion: v.rows[0].visits ? (a.orders / v.rows[0].visits) * 100 : 0,
  };
}

// Ряды по дням: заказы, выручка, визиты, посетители
async function daily(db, tz, b) {
  const [o, v] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE $3), 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders,
              COALESCE(SUM(total) FILTER (WHERE status <> ALL($4)), 0) AS revenue
         FROM webshop.orders WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [b.lo, b.hi, tz, NOT_VALID]),
    db.query(
      `SELECT to_char(date_trunc('day', at AT TIME ZONE $3), 'YYYY-MM-DD') AS day, COUNT(DISTINCT sid)::int AS visits,
              COUNT(DISTINCT vid)::int AS uniques, COUNT(*) FILTER (WHERE kind IN ('page', 'product'))::int AS views
         FROM webshop.visits WHERE at >= $1 AND at < $2 GROUP BY 1`, [b.lo, b.hi, tz]),
  ]);
  const om = new Map(o.rows.map((r) => [r.day, r]));
  const vm = new Map(v.rows.map((r) => [r.day, r]));
  return b.labels.map((day) => ({
    day,
    orders: om.get(day)?.orders || 0,
    revenue: num(om.get(day)?.revenue),
    visits: vm.get(day)?.visits || 0,
    uniques: vm.get(day)?.uniques || 0,
    views: vm.get(day)?.views || 0,
  }));
}

async function funnel(db, b) {
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT sid)::int AS visits,
            COUNT(DISTINCT sid) FILTER (WHERE kind = 'product')::int AS viewed,
            COUNT(DISTINCT sid) FILTER (WHERE kind = 'cart_add')::int AS carted,
            COUNT(DISTINCT sid) FILTER (WHERE kind = 'checkout')::int AS checkout,
            COUNT(DISTINCT sid) FILTER (WHERE kind = 'order')::int AS ordered
       FROM webshop.visits WHERE at >= $1 AND at < $2`, [b.lo, b.hi]);
  return rows[0];
}

const SOURCE_TITLES = { direct: 'Прямые заходы', search: 'Поисковики', social: 'Соцсети', referral: 'Другие сайты' };
async function sources(db, b) {
  const { rows } = await db.query(
    `SELECT source, COUNT(*)::int AS n FROM webshop.visits WHERE source <> '' AND at >= $1 AND at < $2 GROUP BY source ORDER BY n DESC LIMIT 8`, [b.lo, b.hi]);
  return rows.map((r) => ({ key: r.source, title: SOURCE_TITLES[r.source] || `Метка: ${r.source}`, n: r.n }));
}

const DEVICE_TITLES = { mobile: 'Телефон', desktop: 'Компьютер', tablet: 'Планшет' };
async function devices(db, b) {
  const { rows } = await db.query(
    `SELECT device, COUNT(DISTINCT sid)::int AS n FROM webshop.visits WHERE device <> '' AND at >= $1 AND at < $2 GROUP BY device ORDER BY n DESC`, [b.lo, b.hi]);
  return rows.map((r) => ({ key: r.device, title: DEVICE_TITLES[r.device] || r.device, n: r.n }));
}

async function statuses(db, b) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total), 0) AS sum FROM webshop.orders WHERE created_at >= $1 AND created_at < $2 GROUP BY status`, [b.lo, b.hi]);
  return rows.map((r) => ({ status: r.status, n: r.n, sum: num(r.sum) }));
}

async function deliveries(db, b) {
  const { rows } = await db.query(
    `SELECT delivery_title AS title, COUNT(*)::int AS n, COALESCE(SUM(total), 0) AS sum FROM webshop.orders
      WHERE created_at >= $1 AND created_at < $2 AND status <> ALL($3) GROUP BY 1 ORDER BY n DESC`, [b.lo, b.hi, NOT_VALID]);
  return rows.map((r) => ({ title: r.title, n: r.n, sum: num(r.sum) }));
}

async function cities(db, b) {
  const { rows } = await db.query(
    `SELECT CASE WHEN delivery_city = '' THEN 'Самовывоз' ELSE delivery_city END AS city, COUNT(*)::int AS n, COALESCE(SUM(total), 0) AS sum
       FROM webshop.orders WHERE created_at >= $1 AND created_at < $2 AND status <> ALL($3) GROUP BY 1 ORDER BY n DESC LIMIT 6`, [b.lo, b.hi, NOT_VALID]);
  return rows.map((r) => ({ city: r.city, n: r.n, sum: num(r.sum) }));
}

// Модели: просмотры, добавления в корзину, проданные пары и выручка
async function topModels(db, b, limit = 8) {
  const [views, sold] = await Promise.all([
    db.query(
      `SELECT model_key, COUNT(*) FILTER (WHERE kind = 'product')::int AS views, COUNT(*) FILTER (WHERE kind = 'cart_add')::int AS carts
         FROM webshop.visits WHERE model_key <> '' AND at >= $1 AND at < $2 GROUP BY model_key ORDER BY views DESC LIMIT 200`, [b.lo, b.hi]),
    db.query(
      `SELECT oi.model_key, SUM(oi.qty)::int AS qty, SUM(oi.qty * oi.price) AS sum
         FROM webshop.order_items oi JOIN webshop.orders o ON o.id = oi.order_id
        WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status <> ALL($3) GROUP BY oi.model_key`, [b.lo, b.hi, NOT_VALID]),
  ]);
  const soldMap = new Map(sold.rows.map((r) => [r.model_key, { qty: r.qty, sum: num(r.sum) }]));
  const keys = new Map();
  for (const r of views.rows) keys.set(r.model_key, { key: r.model_key, views: r.views, carts: r.carts, qty: 0, sum: 0 });
  for (const [k, s] of soldMap) { const e = keys.get(k) || { key: k, views: 0, carts: 0, qty: 0, sum: 0 }; e.qty = s.qty; e.sum = s.sum; keys.set(k, e); }
  return [...keys.values()].sort((a, b2) => b2.views - a.views || b2.qty - a.qty).slice(0, limit);
}

async function topSold(db, b, limit = 6) {
  const { rows } = await db.query(
    `SELECT oi.model_key, MIN(oi.title) AS title, MIN(oi.photo_id) AS photo_id, SUM(oi.qty)::int AS qty, SUM(oi.qty * oi.price) AS sum
       FROM webshop.order_items oi JOIN webshop.orders o ON o.id = oi.order_id
      WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status <> ALL($3)
      GROUP BY oi.model_key ORDER BY sum DESC LIMIT $4`, [b.lo, b.hi, NOT_VALID, limit]);
  return rows.map((r) => ({ key: r.model_key, title: r.title, photo: r.photo_id, qty: r.qty, sum: num(r.sum) }));
}

async function pages(db, b) {
  const { rows } = await db.query(
    `SELECT path, COUNT(*)::int AS n, COUNT(DISTINCT sid)::int AS visits FROM webshop.visits
      WHERE kind = 'page' AND at >= $1 AND at < $2 GROUP BY path ORDER BY n DESC LIMIT 8`, [b.lo, b.hi]);
  return rows;
}
async function refHosts(db, b) {
  const { rows } = await db.query(
    `SELECT ref_host AS host, COUNT(*)::int AS n FROM webshop.visits WHERE ref_host <> '' AND at >= $1 AND at < $2 GROUP BY 1 ORDER BY n DESC LIMIT 8`, [b.lo, b.hi]);
  return rows;
}

async function recentOrders(db, limit = 7) {
  const { rows } = await db.query(
    `SELECT o.id, o.number, o.created_at, o.name, o.total, o.status, o.delivery_title,
            (SELECT COALESCE(SUM(qty), 0)::int FROM webshop.order_items WHERE order_id = o.id) AS qty
       FROM webshop.orders o ORDER BY o.created_at DESC, o.id DESC LIMIT $1`, [limit]);
  return rows;
}

async function attention(db, writeoff) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS fresh,
            COUNT(*) FILTER (WHERE status = 'new' AND created_at < NOW() - INTERVAL '2 hours')::int AS stale,
            COUNT(*) FILTER (WHERE status IN ('confirmed', 'paid'))::int AS to_pack,
            COUNT(*) FILTER (WHERE status = 'packed')::int AS to_ship
       FROM webshop.orders`);
  return { ...rows[0], toWriteoff: writeoff ? await writeoff.pendingCount() : null };
}

module.exports = {
  RANGES, parseRange, bounds, kpis, daily, funnel, sources, devices, statuses, deliveries, cities, topModels, topSold, pages, refHosts,
  recentOrders, attention, REVENUE_STATUSES, NOT_VALID,
};
