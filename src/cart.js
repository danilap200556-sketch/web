'use strict';
// Корзина хранится на сервере (webshop.carts), в браузере лежит только случайный ключ.
// Состав: [{ pid: <id товара склада = конкретный размер>, qty }].
const MAX_LINES = 30;
const MAX_QTY = 10;

function createCarts(db) {
  async function read(token) {
    if (!token) return [];
    const { rows } = await db.query('SELECT items FROM webshop.carts WHERE token = $1', [token]);
    return rows[0] && Array.isArray(rows[0].items) ? rows[0].items : [];
  }
  async function write(token, items) {
    await db.query(
      `INSERT INTO webshop.carts (token, items, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (token) DO UPDATE SET items = EXCLUDED.items, updated_at = NOW()`, [token, JSON.stringify(items)]);
  }
  async function clear(token) {
    if (token) await db.query('DELETE FROM webshop.carts WHERE token = $1', [token]);
  }
  // Старые корзины чистим по ходу дела
  async function prune() {
    await db.query("DELETE FROM webshop.carts WHERE updated_at < NOW() - INTERVAL '60 days'");
  }
  return { read, write, clear, prune };
}

function add(items, pid, qty = 1) {
  const out = items.map((i) => ({ ...i }));
  const line = out.find((i) => i.pid === pid);
  if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
  else if (out.length < MAX_LINES) out.push({ pid, qty: Math.min(MAX_QTY, qty) });
  return out;
}
function setQty(items, pid, qty) {
  if (qty <= 0) return items.filter((i) => i.pid !== pid);
  return items.map((i) => (i.pid === pid ? { ...i, qty: Math.min(MAX_QTY, qty) } : { ...i }));
}

// Позиции корзины с актуальными ценой и наличием. Всё, что пропало из каталога, помечается и в итог не идёт.
function price(catalog, items) {
  const lines = [];
  let subtotal = 0;
  let count = 0;
  for (const i of items) {
    const hit = catalog.byProduct.get(i.pid);
    if (!hit || hit.model.hidden) { lines.push({ pid: i.pid, gone: true, qty: i.qty }); continue; }
    const { model, size } = hit;
    const max = size.qty;
    const qty = Math.min(i.qty, Math.max(max, 0));
    const ok = max > 0;
    const line = {
      pid: i.pid, model, size, requested: i.qty, qty: ok ? qty : 0, max, price: size.price, sum: ok ? qty * size.price : 0,
      short: ok && qty < i.qty, out: !ok,
    };
    if (ok) { subtotal += line.sum; count += qty; }
    lines.push(line);
  }
  return { lines, subtotal, count };
}

module.exports = { createCarts, add, setQty, price, MAX_QTY, MAX_LINES };
