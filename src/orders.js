'use strict';
const crypto = require('crypto');
const { RESERVING, queueFilter } = require('./catalog');
const { quote, cityAllowed, PAY_METHODS } = require('./delivery');
const { normalizePhone, isEmail, str } = require('./util');

class OrderError extends Error {}

// Статусы заказа. reserving - держит ли заказ товар в резерве (после "shipped" товар уже списан складом).
const STATUSES = {
  new: { title: 'Новый', tone: 'blue', step: 0 },
  confirmed: { title: 'Подтверждён', tone: 'violet', step: 1 },
  paid: { title: 'Оплачен', tone: 'teal', step: 2 },
  packed: { title: 'Собран', tone: 'amber', step: 3 },
  shipped: { title: 'Отправлен', tone: 'orange', step: 4 },
  delivered: { title: 'Получен', tone: 'green', step: 5 },
  cancelled: { title: 'Отменён', tone: 'gray', step: -1 },
  returned: { title: 'Возврат', tone: 'red', step: -1 },
};
const REVENUE_STATUSES = ['confirmed', 'paid', 'packed', 'shipped', 'delivered']; // деньги в работе и полученные
const FLOW = ['new', 'confirmed', 'paid', 'packed', 'shipped', 'delivered'];

const newToken = () => crypto.randomBytes(18).toString('base64url');

// Проверка формы оформления + расчёт. Возвращает данные заказа или бросает OrderError с текстом для покупателя.
function validateCheckout(body, methods, points, subtotal) {
  const name = str(body.name, 80);
  if (name.length < 2) throw new OrderError('Укажите, как к вам обращаться');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new OrderError('Укажите телефон в формате +7 900 123-45-67');
  const email = str(body.email, 120);
  if (email && !isEmail(email)) throw new OrderError('Проверьте адрес электронной почты');
  if (body.consent !== '1' && body.consent !== 'on') throw new OrderError('Нужно согласие на обработку персональных данных');

  const m = methods.find((x) => x.code === body.delivery && x.active);
  if (!m) throw new OrderError('Выберите способ доставки');
  const city = str(body.city, 80);
  let address = str(body.address, 250);
  let point = '';
  let door = false;
  if (m.kind === 'pickup') {
    const p = points.find((x) => String(x.id) === String(body.point) && x.active);
    if (!p) throw new OrderError('Выберите пункт самовывоза');
    point = `${p.title}, ${p.address}`;
    address = '';
  } else {
    if (!city) throw new OrderError('Укажите город доставки');
    if (!cityAllowed(m, city)) throw new OrderError(`«${m.title}» работает только в: ${m.cities}. Выберите другой способ`);
    if (m.kind === 'courier') door = true;
    if (m.kind === 'tc') door = body.mode === 'door';
    if (door && address.length < 5) throw new OrderError('Укажите адрес доставки: улицу, дом и квартиру');
    if (!door) {
      point = str(body.tcpoint, 250);
      if (point.length < 3) throw new OrderError('Укажите пункт выдачи: адрес или номер отделения');
      address = '';
    }
  }
  const pay = PAY_METHODS[body.pay] ? body.pay : '';
  if (!pay) throw new OrderError('Выберите способ оплаты');
  if (pay === 'cod' && m.kind === 'tc') throw new OrderError('Для доставки транспортной компанией нужна онлайн-оплата');
  const q = quote(m, subtotal, door);
  return {
    name, phone, email, comment: str(body.comment, 500), city: m.kind === 'pickup' ? '' : city, address, point, door, pay,
    delivery: m, deliveryCost: q.price, total: subtotal + q.price,
  };
}

// Создаёт заказ одной транзакцией. priced - результат cart.price() (только годные позиции).
async function createOrder(db, { form, priced, catalog, idemKey, vid, sid, source, notifier }) {
  const lines = priced.lines.filter((l) => !l.gone && !l.out && l.qty > 0);
  if (!lines.length) throw new OrderError('Корзина пуста');
  const result = await db.tx(async (c) => {
    // Один заказ за раз: так два покупателя не займут последнюю пару одновременно (пользователю сайта нельзя блокировать строки склада)
    await c.query('SELECT pg_advisory_xact_lock(727302)');
    if (idemKey) {
      const dup = await c.query('SELECT number, token FROM webshop.orders WHERE idem_key = $1', [idemKey]);
      if (dup.rows[0]) return { number: dup.rows[0].number, token: dup.rows[0].token, repeated: true };
    }
    const ids = lines.map((l) => l.pid);
    const avail = await c.query(
      `SELECT p.id,
              GREATEST(COALESCE((SELECT SUM(quantity) FROM stock WHERE product_id = p.id), 0), 0)::int
              - COALESCE((SELECT SUM(oi.qty) FROM webshop.order_items oi JOIN webshop.orders o ON o.id = oi.order_id
                           WHERE oi.product_id = p.id AND o.status = ANY($2) ${queueFilter(catalog.queueOk !== false)}), 0)::int AS free
         FROM products p WHERE p.id = ANY($1)`, [ids, RESERVING]);
    const free = new Map(avail.rows.map((r) => [r.id, r.free]));
    const short = lines.filter((l) => (free.get(l.pid) ?? 0) < l.qty);
    if (short.length) {
      throw new OrderError('Пока вы оформляли заказ, часть товаров разобрали: ' +
        short.map((l) => `${l.model.title}, размер ${l.size.label}`).join('; ') + '. Обновите корзину');
    }
    const cust = await c.query(
      `INSERT INTO webshop.customers (phone, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = CASE WHEN webshop.customers.name = '' THEN EXCLUDED.name ELSE webshop.customers.name END,
                                         email = CASE WHEN webshop.customers.email = '' THEN EXCLUDED.email ELSE webshop.customers.email END
       RETURNING id`, [form.phone, form.name, form.email]);
    const seq = await c.query("SELECT nextval('webshop.order_number_seq')::text AS n");
    const number = seq.rows[0].n;
    const token = newToken();
    const subtotal = lines.reduce((a, l) => a + l.sum, 0);
    const d = form.delivery;
    const total = subtotal + form.deliveryCost;
    const ins = await c.query(
      `INSERT INTO webshop.orders (number, token, idem_key, customer_id, name, phone, email, delivery_code, delivery_title, delivery_kind,
                                delivery_city, delivery_address, delivery_point, delivery_door, delivery_cost, pay_method, subtotal, total,
                                comment, vid, sid, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [number, token, idemKey || null, cust.rows[0].id, form.name, form.phone, form.email, d.code, d.title, d.kind,
        form.city, form.address, form.point, form.door, form.deliveryCost, form.pay, subtotal, total, form.comment, vid || '', sid || '', source || '']);
    const orderId = ins.rows[0].id;
    for (const l of lines) {
      await c.query(
        `INSERT INTO webshop.order_items (order_id, product_id, sku, model_key, title, type, size, photo_id, price, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orderId, l.pid, l.size.sku, l.model.key, l.model.title + (l.model.colorway ? ` «${l.model.colorway}»` : ''), l.model.type,
          l.size.label, l.model.cover || null, l.price, l.qty]);
    }
    await c.query("INSERT INTO webshop.order_events (order_id, kind, text) VALUES ($1, 'status', 'Заказ оформлен на сайте')", [orderId]);
    if (notifier) await notifier.enqueue(c, orderId); // уведомление в той же транзакции: заказ без него не появится
    return { number, token, orderId, total, repeated: false };
  });
  catalog.invalidate();
  if (notifier && !result.repeated) notifier.kick();
  return result;
}

async function getOrderByToken(db, number, token) {
  const { rows } = await db.query('SELECT * FROM webshop.orders WHERE number = $1', [String(number)]);
  const o = rows[0];
  if (!o || !token || o.token.length !== String(token).length || !crypto.timingSafeEqual(Buffer.from(o.token), Buffer.from(String(token)))) return null;
  const items = await db.query('SELECT * FROM webshop.order_items WHERE order_id = $1 ORDER BY id', [o.id]);
  const events = await db.query('SELECT * FROM webshop.order_events WHERE order_id = $1 ORDER BY at, id', [o.id]);
  return { ...o, items: items.rows, events: events.rows };
}

module.exports = { OrderError, STATUSES, FLOW, REVENUE_STATUSES, validateCheckout, createOrder, getOrderByToken, newToken };
