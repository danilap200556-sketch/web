'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin } = require('./helpers');

// Заказ сайта проходит путь покупателя; возвращает { number, orderId }
async function placeOrder(shop, pid, qty = 1, phone = '89160000001') {
  const c = client(shop.base);
  await c.get('/');
  for (let i = 0; i < qty; i++) await c.post('/cart/add', { pid });
  const co = (await c.get('/checkout')).text;
  const r = await c.post('/checkout', {
    idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone, delivery: 'pickup',
    point: /name="point" value="(\d+)"/.exec(co)[1], pay: 'cod', consent: '1',
  });
  assert.equal(r.status, 303, r.text.slice(0, 200));
  const number = /\/order\/(\d+)/.exec(r.location)[1];
  const orderId = (await shop.db.query('SELECT id FROM webshop.orders WHERE number = $1', [number])).rows[0].id;
  return { number, orderId };
}

test.describe('очередь списания (order_writeoffs)', () => {
  let shop;
  let admin;
  const queue = async (number) => (await shop.db.query("SELECT * FROM order_writeoffs WHERE source = 'site' AND account_id = 0 AND order_ref = $1", [number])).rows[0];
  const setStatus = async (orderId, status) => {
    const r = await admin.c.post(`/admin/orders/${orderId}/status`, { _csrf: admin.csrf, status });
    assert.equal(r.status, 302);
  };

  test.before(async () => {
    shop = await startShop('writeoff');
    admin = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  });
  test.after(async () => { await shop.stop(); });

  test('заказ «Собран» встаёт в очередь с артикулом, названием и количеством; до этого его там нет', async () => {
    const p = await addProduct(shop.db, { sku: 'WQ-1_42', name: 'Кроссовки Nike Queue One «Black»', price: 9000, qty: 5 });
    const { number, orderId } = await placeOrder(shop, p, 2);
    assert.equal(await queue(number), undefined, 'новый заказ в очередь не попадает: он ещё не подтверждён');
    await setStatus(orderId, 'confirmed');
    assert.equal(await queue(number), undefined);
    await setStatus(orderId, 'packed');
    const q = await queue(number);
    assert.equal(q.state, 'pending');
    assert.deepEqual(q.lines, [{ key: 'WQ-1_42', name: 'Nike Queue One «Black»', qty: 2 }]);
    assert.equal(q.account_id, 0);
    // повторная сверка и повторный статус ничего не дублируют
    await shop.services.writeoff.sync();
    assert.equal((await shop.db.query("SELECT COUNT(*)::int AS n FROM order_writeoffs WHERE order_ref = $1", [number])).rows[0].n, 1);
    assert.match((await admin.c.get(`/admin/orders/${orderId}`)).text, /Ждёт списания: сотрудник спишет его в приложении/);
  });

  test('отмена до списания снимает заказ с очереди; вернули в работу и собрали - снова в очереди', async () => {
    const p = await addProduct(shop.db, { sku: 'WQ-2_42', name: 'Кроссовки Nike Queue Two', price: 9000, qty: 5 });
    const { number, orderId } = await placeOrder(shop, p, 1, '89160000002');
    await setStatus(orderId, 'packed');
    assert.equal((await queue(number)).state, 'pending');
    await setStatus(orderId, 'cancelled');
    assert.equal((await queue(number)).state, 'cancelled');
    await setStatus(orderId, 'new');
    await setStatus(orderId, 'packed');
    assert.equal((await queue(number)).state, 'pending', 'заказ вернули в работу - снова ждёт списания');
  });

  test('отмена после списания просит вернуть пару на склад', async () => {
    const p = await addProduct(shop.db, { sku: 'WQ-3_42', name: 'Кроссовки Nike Queue Three', price: 9000, qty: 5 });
    const { number, orderId } = await placeOrder(shop, p, 1, '89160000003');
    await setStatus(orderId, 'packed');
    await shop.db.query("UPDATE order_writeoffs SET state = 'written_off' WHERE order_ref = $1", [number]); // сотрудник списал в приложении
    await setStatus(orderId, 'cancelled');
    assert.equal((await queue(number)).state, 'cancel_requested');
    assert.match((await admin.c.get(`/admin/orders/${orderId}`)).text, /ждёт возврата пары на склад в приложении/);
    await setStatus(orderId, 'returned');
    assert.equal((await queue(number)).state, 'cancel_requested', 'состояние не меняется повторно');
  });

  test('списанный в приложении заказ перестаёт быть резервом: пары не вычитаются второй раз', async () => {
    const p = await addProduct(shop.db, { sku: 'WQ-4_42', name: 'Кроссовки Nike Queue Four', price: 9000, qty: 4 });
    const { number, orderId } = await placeOrder(shop, p, 1, '89160000004');
    await setStatus(orderId, 'packed');
    const { catalog } = shop.services;
    await catalog.ensure();
    assert.equal(catalog.byProduct.get(p).size.qty, 3, 'в резерве 1 пара: из 4 свободно 3');
    // сотрудник списал заказ в приложении: остаток склада стал 3, очередь - written_off
    await shop.db.query('UPDATE stock SET quantity = 3 WHERE product_id = $1', [p]);
    await shop.db.query("UPDATE order_writeoffs SET state = 'written_off' WHERE order_ref = $1", [number]);
    catalog.invalidate();
    await catalog.ensure();
    assert.equal(catalog.byProduct.get(p).size.qty, 3, 'свободно по-прежнему 3, а не 2: резерв снят, пара уже вычтена со склада');
    // и при оформлении нового заказа считается так же
    await placeOrder(shop, p, 3, '89160000005');
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders WHERE phone = $1', ['79160000005'])).rows[0].n, 1, 'три свободные пары продаются');
  });

  test('заказы, отправленные до подключения очереди, в неё не попадают; собранные - попадают', async () => {
    const p = await addProduct(shop.db, { sku: 'WQ-5_42', name: 'Кроссовки Nike Queue Five', price: 9000, qty: 9 });
    const mk = async (number, status, daysAgo) => {
      const c = await shop.db.query(
        `INSERT INTO webshop.customers (phone, name) VALUES ($1, 'Старый') ON CONFLICT (phone) DO UPDATE SET name = 'Старый' RETURNING id`, ['7' + number.padStart(10, '0')]);
      const o = await shop.db.query(
        `INSERT INTO webshop.orders (number, token, customer_id, status, name, phone, delivery_code, delivery_title, delivery_kind, pay_method, subtotal, total, created_at, updated_at)
         VALUES ($1, 'tok', $2, $3, 'Старый', $4, 'pickup', 'Самовывоз', 'pickup', 'cod', 9000, 9000, NOW() - $5 * INTERVAL '1 day', NOW() - $5 * INTERVAL '1 day') RETURNING id`,
        [number, c.rows[0].id, status, '7' + number.padStart(10, '0'), daysAgo]);
      await shop.db.query(`INSERT INTO webshop.order_items (order_id, product_id, sku, title, price, qty) VALUES ($1, $2, 'WQ-5_42', 'Nike Queue Five', 9000, 1)`, [o.rows[0].id, p]);
    };
    await mk('900001', 'delivered', 30);
    await mk('900002', 'shipped', 10);
    await mk('900003', 'packed', 10);
    await shop.services.writeoff.sync();
    assert.equal(await queue('900001'), undefined, 'доставлен давно - не трогаем');
    assert.equal(await queue('900002'), undefined, 'отправлен до подключения очереди - не трогаем');
    assert.equal((await queue('900003')).state, 'pending', 'собран и ещё не отправлен - в очередь');
  });

  test('сводка показывает, сколько заказов ждёт списания', async () => {
    const html = (await admin.c.get('/admin')).text;
    assert.match(html, /ждут списания в приложении «Склад»/);
  });
});

test('нет таблицы очереди: заказы и смена статусов работают, в админке подсказка, резерв считается по заказам', async () => {
  const shop = await startShop('writeoff2', {}, { queue: false });
  try {
    const admin = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const p = await addProduct(shop.db, { sku: 'WN-1_42', name: 'Кроссовки Nike No Queue', price: 9000, qty: 2 });
    const { orderId } = await placeOrder(shop, p, 1);
    const r = await admin.c.post(`/admin/orders/${orderId}/status`, { _csrf: admin.csrf, status: 'packed' });
    assert.equal(r.status, 302);
    assert.equal((await shop.db.query('SELECT status FROM webshop.orders WHERE id = $1', [orderId])).rows[0].status, 'packed');
    assert.equal(shop.services.writeoff.state.status, 'missing');
    assert.match((await admin.c.get(`/admin/orders/${orderId}`)).text, /Связь со складом не настроена: в базе нет таблицы order_writeoffs/);
    await shop.services.catalog.ensure();
    assert.equal(shop.services.catalog.byProduct.get(p).size.qty, 1, 'без очереди пара остаётся в резерве заказа');
    assert.equal((await admin.c.get('/admin')).status, 200);
  } finally { await shop.stop(); }
});
