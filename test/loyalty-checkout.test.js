'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addSitePrice, ymd, loginAs, placeOrder, adminLogin, fakeTelegram } = require('./helpers');

let shop, tg, pidA, pidB;
test.before(async () => {
  tg = await fakeTelegram();
  shop = await startShop('loyco', { TELEGRAM_BOT_TOKEN: '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123', TELEGRAM_CHAT_ID: '111', TELEGRAM_API_URL: tg.url, PUBLIC_URL: 'https://shop.test', TRUST_PROXY: '1' });
  pidA = await addProduct(shop.db, { sku: 'LC-1_42', name: 'Кроссовки Nike Loyal «Regular»', price: 10000, qty: 200 });
  pidB = await addProduct(shop.db, { sku: 'LC-2_42', name: 'Кроссовки Nike Loyal «Sale»', price: 8000, qty: 200 });
  await addSitePrice(shop.db, 'LC-2', { price: 8000, sale: 6000, from: ymd(-1), to: ymd(5) });
});
test.after(async () => { await shop.stop(); await tg.close(); });

let seq = 9500;
async function spend(customerId, amount, status = 'delivered') {
  const number = String(++seq);
  await shop.db.query(
    `INSERT INTO webshop.orders (number, token, customer_id, status, name, phone, delivery_code, delivery_title, delivery_kind, pay_method, subtotal, discount, total)
     VALUES ($1, $1, $2, $3, 'Т', '79160000000', 'pickup', 'Самовывоз', 'pickup', 'cod', $4, 0, $4)`, [number, customerId, status, amount]);
}
const order = async (id) => (await shop.db.query('SELECT * FROM webshop.orders WHERE id = $1', [id])).rows[0];
async function buyer(phone, spent = 40000) {
  const c = client(shop.base);
  const cust = await loginAs(shop, c, phone, { name: 'Анна' });
  if (spent) await spend(cust.id, spent);
  return { c, cust };
}

test('уровень «Серебро»: 3% с обычных товаров, скидка записана в заказ и видна на странице заказа', async () => {
  const { c, cust } = await buyer('79160000601');
  const { orderId, location } = await placeOrder(shop, pidA, { c, phone: '79160000601' });
  const o = await order(orderId);
  assert.equal(Number(o.subtotal), 10000);
  assert.equal(Number(o.discount), 300);
  assert.equal(Number(o.total), 9700);
  assert.equal(Number(o.discount_pct), 3);
  assert.match(o.discount_note, /Серебро/);
  assert.equal(o.customer_id, cust.id);
  const page = (await c.get(location)).text;
  assert.match(page, /Скидка 3%/);
  assert.match(page, /300\s₽/);
});

test('гость с номером клиента скидки не получает', async () => {
  await buyer('79160000602');
  const { orderId } = await placeOrder(shop, pidA, { phone: '79160000602' });
  const o = await order(orderId);
  assert.equal(Number(o.discount), 0);
  assert.equal(Number(o.total), 10000);
});

test('акционные позиции в скидку не входят, смесь считается только по обычным', async () => {
  const { c } = await buyer('79160000603');
  const mixed = await order((await placeOrder(shop, [pidA, pidB], { c, phone: '79160000603' })).orderId);
  assert.equal(Number(mixed.subtotal), 16000);        // 10 000 обычный + 6 000 по акции
  assert.equal(Number(mixed.discount), 300);          // 3% только с 10 000
  assert.equal(Number(mixed.total), 15700);
  const only = await placeOrder(shop, pidB, { c, phone: '79160000603' });
  const o = await order(only.orderId);
  assert.equal(Number(o.discount), 0);
  assert.equal(o.discount_note, '');
  assert.ok(!/Скидка \d/.test((await c.get(only.location)).text), 'строки скидки нет');
});

test('порог уровня: ровно 30 000 ₽ даёт 3%, 29 999 ₽ нет; округление вниз', async () => {
  const a = await buyer('79160000604', 30000);
  const b = await buyer('79160000605', 29999);
  assert.equal(Number((await order((await placeOrder(shop, pidA, { c: a.c, phone: '79160000604' })).orderId)).discount), 300);
  assert.equal(Number((await order((await placeOrder(shop, pidA, { c: b.c, phone: '79160000605' })).orderId)).discount), 0);
  // 3% от 10 000 ₽ x 3 = 900; от 10 000 + 6 ₽ копейки не бывает: проверяем округление вниз на нечётной сумме
  await shop.db.query('UPDATE products SET price = 9999 WHERE id = $1', [pidA]);
  try {
    const o = await order((await placeOrder(shop, pidA, { c: a.c, phone: '79160000604' })).orderId);
    assert.equal(Number(o.subtotal), 9999);
    assert.equal(Number(o.discount), 299);            // 299,97 -> 299
  } finally { await shop.db.query('UPDATE products SET price = 10000 WHERE id = $1', [pidA]); }
});

test('личная скидка больше уровня заменяет его, а не складывается', async () => {
  const { c, cust } = await buyer('79160000606');
  await shop.db.query('UPDATE webshop.customers SET personal_discount = 10 WHERE id = $1', [cust.id]);
  const o = await order((await placeOrder(shop, pidA, { c, phone: '79160000606' })).orderId);
  assert.equal(Number(o.discount), 1000);
  assert.equal(Number(o.discount_pct), 10);
  assert.match(o.discount_note, /Личная скидка 10%/);
});

test('получатель с другим телефоном: заказ остаётся в аккаунте, чужой клиент не создаётся', async () => {
  const { c, cust } = await buyer('79160000607');
  const o = await order((await placeOrder(shop, pidA, { c, phone: '79160000699', name: 'Мама' })).orderId);
  assert.equal(o.customer_id, cust.id);
  assert.equal(o.phone, '79160000699');
  assert.equal((await shop.db.query("SELECT COUNT(*)::int AS n FROM webshop.customers WHERE phone = '79160000699'")).rows[0].n, 0);
});

test('лояльность выключена: вошедший без скидки, но заказ в его аккаунте', async () => {
  const { c, cust } = await buyer('79160000608');
  await shop.services.settings.set({ loyalty: { ...shop.services.settings.defaults.loyalty, enabled: false } });
  try {
    const o = await order((await placeOrder(shop, pidA, { c, phone: '79160000608' })).orderId);
    assert.equal(Number(o.discount), 0);
    assert.equal(o.customer_id, cust.id);
  } finally { await shop.services.settings.set({ loyalty: shop.services.settings.defaults.loyalty }); }
});

test('корзина, оформление и /api/cart показывают скидку; форма заполнена из профиля', async () => {
  const { c } = await buyer('79160000609');
  await c.get('/');
  await c.post('/cart/add', { pid: pidA });
  const api = JSON.parse((await c.get('/api/cart')).text);
  assert.equal(api.subtotal, 10000);
  assert.equal(api.discount, 300);
  assert.equal(api.discountPct, 3);
  const cart = (await c.get('/cart')).text;
  assert.match(cart, /Скидка 3%/);
  assert.match(cart, /−300\s₽/);
  const co = (await c.get('/checkout')).text;
  assert.match(co, /data-sum-discount data-value="300"/);
  assert.match(co, /value="Анна"/);
  assert.match(co, /value="\+7 \(916\) 000-06-09"/);
  // всё по акции: строки скидки нет
  const c2 = (await buyer('79160000610')).c;
  await c2.get('/');
  await c2.post('/cart/add', { pid: pidB });
  assert.equal(JSON.parse((await c2.get('/api/cart')).text).discount, 0);
  assert.ok(!/Скидка \d/.test((await c2.get('/cart')).text));
  assert.ok(!/data-sum-discount/.test((await c2.get('/checkout')).text));
});

test('гость видит приглашение войти (скидка до 7%) и скидки не получает', async () => {
  const g = client(shop.base);
  await g.get('/');
  await g.post('/cart/add', { pid: pidA });
  const api = JSON.parse((await g.get('/api/cart')).text);
  assert.equal(api.discount, 0);
  const cart = (await g.get('/cart')).text;
  assert.ok(!/Скидка \d/.test(cart));
  assert.match(cart, /Войдите<\/a>: скидка до 7%/);                 // вход настроен (бот), лояльность включена
  const co = (await g.get('/checkout')).text;
  assert.match(co, /скидка до 7%/);
  assert.ok(!/data-sum-discount/.test(co));
});

test('уведомление сотрудникам и карточка заказа в админке содержат скидку', async () => {
  const { c } = await buyer('79160000611');
  const { orderId } = await placeOrder(shop, pidA, { c, phone: '79160000611' });
  let text = '';
  for (let i = 0; i < 80 && !/Скидка/.test(text); i++) {
    text = tg.calls.filter((x) => x.url.endsWith('/sendMessage')).map((x) => x.body.text).join('\n');
    if (!/Скидка/.test(text)) await new Promise((r) => setTimeout(r, 25));
  }
  assert.match(text, /Скидка «Серебро» 3%: −300\s₽/);
  const { c: adm } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  const page = (await adm.get(`/admin/orders/${orderId}`)).text;
  assert.match(page, /Скидка «Серебро» 3%/);
});
