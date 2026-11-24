'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin, addAdmin, loginAs, placeOrder, fakeSmsRu, fakeTelegram } = require('./helpers');

let shop, sms, tg, owner, mgr, pid, ipn = 0, seq = 9800;
test.before(async () => {
  sms = await fakeSmsRu();
  tg = await fakeTelegram();
  shop = await startShop('adminloy', {
    SMS_PROVIDER: 'smsru', SMS_API_KEY: 'k', SMS_API_URL: sms.url, TRUST_PROXY: '1', SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Shop <s@test.ru>',
    TELEGRAM_BOT_TOKEN: '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_URL: tg.url, TELEGRAM_BOT_USERNAME: 'solehouse_test_bot',
  });
  pid = await addProduct(shop.db, { sku: 'AL-1_42', name: 'Кроссовки Nike Admin «Loyalty»', price: 10000, qty: 100 });
  await addAdmin(shop.db, 'mgr1', 'manager');
  owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  mgr = await adminLogin(shop.base, 'mgr1', 'pass-12345');
});
test.after(async () => { await shop.stop(); await sms.close(); await tg.close(); });

const L = async () => (await shop.services.settings.get()).loyalty;
const form = (tiers, extra = {}) => [['_csrf', owner.csrf], ['enabled', 'on'], ['applyToElectronics', 'on'], ...Object.entries(extra),
  ...tiers.flatMap(([n, f, p]) => [['tierName', n], ['tierFrom', String(f)], ['tierPercent', String(p)]])];
async function customer(phone, spent = 0) {
  const c = client(shop.base);
  const cust = await loginAs(shop, c, phone, { name: 'Анна' });
  if (spent) {
    const number = String(++seq);
    await shop.db.query(
      `INSERT INTO webshop.orders (number, token, customer_id, status, name, phone, delivery_code, delivery_title, delivery_kind, pay_method, subtotal, discount, total)
       VALUES ($1, $1, $2, 'delivered', 'Т', $3, 'pickup', 'Самовывоз', 'pickup', 'cod', $4, 0, $4)`, [number, cust.id, phone, spent]);
  }
  return { c, cust };
}
const order = async (id) => (await shop.db.query('SELECT * FROM webshop.orders WHERE id = $1', [id])).rows[0];
const place = (c, phone) => placeOrder(shop, pid, { c, phone, name: 'Анна' });

test('владелец видит страницу «Лояльность» с уровнями по умолчанию', async () => {
  const r = await owner.c.get('/admin/loyalty');
  assert.equal(r.status, 200);
  for (const name of ['Старт', 'Серебро', 'Золото', 'Платина']) assert.ok(r.text.includes(name), name);
  assert.match(r.text, /value="30000"/);
  assert.match(r.text, /name="applyToElectronics"[^>]*checked/);
  assert.match(r.text, /href="\/admin\/loyalty"/, 'пункт меню');
});

test('сохранение уровней: новые значения применяются к следующему заказу, пустые строки игнорируются', async () => {
  const { c, cust } = await customer('79160000801', 5000);
  const r = await owner.c.post('/admin/loyalty', form([['Старт', 0, 0], ['Бронза', 1000, 10], ['', '', '']]));
  assert.equal(r.status, 302);
  try {
    const rules = await L();
    assert.deepEqual(rules.tiers.map((t) => t.name), ['Старт', 'Бронза']);
    assert.equal(rules.tiers[1].percent, 10);
    const o = await order((await place(c, '79160000801')).orderId);
    assert.equal(Number(o.discount), 1000);
    assert.equal(o.customer_id, cust.id);
    assert.match((await owner.c.get('/admin/loyalty')).text, /Бронза/);
  } finally {
    await shop.services.settings.set({ loyalty: shop.services.settings.defaults.loyalty });
  }
});

test('неверные пороги: ошибка с введёнными значениями, ничего не сохранено', async () => {
  const r = await owner.c.post('/admin/loyalty', form([['Старт', 0, 0], ['А', 30000, 3], ['Б', 20000, 5]]));
  assert.equal(r.status, 422);
  assert.match(r.text, /должен быть больше порога/);
  assert.ok(r.text.includes('value="20000"'), 'введённое не потеряно');
  assert.equal((await L()).tiers.length, 4);
});

test('без токена CSRF форма отклоняется', async () => {
  const r = await owner.c.post('/admin/loyalty', form([['Старт', 0, 0], ['А', 1000, 3]]).filter(([k]) => k !== '_csrf'));
  assert.equal(r.status, 403);
  assert.match(r.text, /Страница устарела/);
  assert.equal((await L()).tiers.length, 4);
});

test('менеджеру раздел и личные скидки недоступны', async () => {
  const { cust } = await customer('79160000802');
  assert.equal((await mgr.c.get('/admin/loyalty')).status, 403);
  assert.equal((await mgr.c.post('/admin/loyalty', form([['Старт', 0, 0], ['А', 1000, 3]]).map(([k, v]) => (k === '_csrf' ? [k, mgr.csrf] : [k, v])))).status, 403);
  const r = await mgr.c.post(`/admin/customers/${cust.id}/discount`, { _csrf: mgr.csrf, percent: '10' });
  assert.equal(r.status, 403);
  assert.equal(Number((await shop.services.accounts.byId(cust.id)).personal_discount), 0);
  const card = (await mgr.c.get(`/admin/customers/${cust.id}`)).text;
  assert.ok(!card.includes(`action="/admin/customers/${cust.id}/discount"`), 'менеджер формы скидки не видит');
});

test('личная скидка из админки действует на следующий заказ и выше уровня не складывается', async () => {
  const { c, cust } = await customer('79160000803', 40000);
  const bad = await owner.c.post(`/admin/customers/${cust.id}/discount`, { _csrf: owner.csrf, percent: '150' });
  assert.equal(bad.status, 302);
  assert.equal(Number((await shop.services.accounts.byId(cust.id)).personal_discount), 0, '150% не принимается');
  assert.match((await owner.c.get(`/admin/customers/${cust.id}`)).text, /от 0 до 100/);
  await owner.c.post(`/admin/customers/${cust.id}/discount`, { _csrf: owner.csrf, percent: '10' });
  assert.equal(Number((await shop.services.accounts.byId(cust.id)).personal_discount), 10);
  const o = await order((await place(c, '79160000803')).orderId);
  assert.equal(Number(o.discount), 1000);                              // 10%, а не 10% + 3%
  await owner.c.post(`/admin/customers/${cust.id}/discount`, { _csrf: owner.csrf, percent: '' });   // пусто - снять
  assert.equal(Number((await shop.services.accounts.byId(cust.id)).personal_discount), 0);
});

test('список и карточка клиента показывают уровень, карту, накопленную сумму и Telegram', async () => {
  const { cust } = await customer('79160000804', 40000);
  await shop.services.accounts.bindTelegram(cust.id, 5151);
  const list = (await owner.c.get('/admin/customers?q=79160000804')).text;
  assert.match(list, /<th>Уровень<\/th>/);
  assert.match(list, /Серебро/);
  const card = (await owner.c.get(`/admin/customers/${cust.id}`)).text;
  assert.match(card, new RegExp(`SH-${String(cust.id).padStart(6, '0')}`));
  assert.match(card, /Серебро/);
  assert.match(card, /40\s000\s₽/);
  assert.match(card, /Telegram: привязан/);
  assert.ok(card.includes(`action="/admin/customers/${cust.id}/discount"`));
});

test('настройки: блок «Вход покупателей» и тестовое SMS', async () => {
  const page = (await owner.c.get('/admin/settings')).text;
  assert.match(page, /Вход покупателей/);
  assert.match(page, /Telegram-бот/);
  assert.match(page, /SMS подключены/);
  assert.match(page, /Почта подключена/);
  assert.match(page, /@solehouse_test_bot/);
  assert.match(page, /action="\/admin\/settings\/test-sms"/);
  const n = sms.calls.length;
  assert.equal((await owner.c.post('/admin/settings/test-sms', { _csrf: owner.csrf, phone: '+7 916 000-08-05' })).status, 302);
  assert.equal(sms.calls.length, n + 1);
  assert.equal(sms.calls.at(-1).to, '79160000805');
  assert.match((await owner.c.get('/admin/settings')).text, /Тестовое SMS отправлено/);
  await owner.c.post('/admin/settings/test-sms', { _csrf: owner.csrf, phone: '123' });
  assert.match((await owner.c.get('/admin/settings')).text, /Укажите телефон/);
  assert.equal(sms.calls.length, n + 1, 'неверный номер не уходит');
  sms.mode.fail = true;
  await owner.c.post('/admin/settings/test-sms', { _csrf: owner.csrf, phone: '+7 916 000-08-06' });
  sms.mode.fail = false;
  assert.match((await owner.c.get('/admin/settings')).text, /Не удалось отправить/);
});
