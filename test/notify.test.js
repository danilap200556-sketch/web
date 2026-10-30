'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startShop, client, addProduct, adminLogin } = require('./helpers');

const TOKEN = '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123';

// Поддельный Telegram Bot API: запоминает запросы, ответ можно переключать
async function fakeTelegram() {
  const calls = [];
  const mode = { fail: 0, status: 200, body: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url, body });
      if (mode.fail > 0) { mode.fail--; res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, description: 'Internal Server Error' })); return; }
      if (mode.body) { res.writeHead(mode.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(mode.body)); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, mode, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function placeOrder(shop, pid, { phone = '89160000001', qty = 1, comment = '' } = {}) {
  const c = client(shop.base);
  await c.get('/');
  for (let i = 0; i < qty; i++) await c.post('/cart/add', { pid });
  const co = (await c.get('/checkout')).text;
  const r = await c.post('/checkout', {
    idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone, delivery: 'pickup',
    point: /name="point" value="(\d+)"/.exec(co)[1], pay: 'cod', consent: '1', comment,
  });
  assert.equal(r.status, 303, r.text.slice(0, 200));
  const number = /\/order\/(\d+)/.exec(r.location)[1];
  const orderId = (await shop.db.query('SELECT id FROM webshop.orders WHERE number = $1', [number])).rows[0].id;
  return { number, orderId };
}
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('не дождались'); await new Promise((r) => setTimeout(r, 25)); }
};

test.describe('уведомления о заказах (Telegram)', () => {
  let shop, tg, pid;
  const outbox = async () => (await shop.db.query('SELECT * FROM webshop.outbox ORDER BY id')).rows;

  test.before(async () => {
    tg = await fakeTelegram();
    shop = await startShop('notify', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111, -222', TELEGRAM_API_URL: tg.url, PUBLIC_URL: 'https://shop.test' });
    pid = await addProduct(shop.db, { sku: 'NT-1_42', name: 'Кроссовки Nike Notify «Test»', price: 11990, qty: 20 });
  });
  test.after(async () => { await shop.stop(); await tg.close(); });

  test('новый заказ приходит в Telegram: номер, сумма, клиент, состав, ссылка в админку', async () => {
    const { number, orderId } = await placeOrder(shop, pid, { comment: 'Позвоните после 18:00' });
    await waitFor(async () => tg.calls.length >= 2);
    assert.equal(tg.calls.length, 2, 'в оба чата');
    assert.deepEqual(tg.calls.map((c) => c.body.chat_id).sort(), ['-222', '111']);
    assert.ok(tg.calls.every((c) => c.url === `/bot${TOKEN}/sendMessage`));
    const text = tg.calls[0].body.text;
    assert.match(text, new RegExp(`Новый заказ №${number}`));
    assert.match(text, /11\s?990/);
    assert.match(text, /Анна/);
    assert.match(text, /Nike Notify «Test»/);
    assert.match(text, /42 × 1/);
    assert.match(text, /Позвоните после 18:00/);
    assert.match(text, new RegExp(`https://shop.test/admin/orders/${orderId}`));
    const row = await waitFor(async () => (await outbox()).find((r) => r.order_id === orderId && r.sent_at));
    assert.equal(row.attempts, 1);
    assert.equal(tg.calls[0].body.disable_web_page_preview, true);
  });

  test('сбой Telegram: заказ оформлен, уведомление повторяется и доходит один раз', async () => {
    tg.calls.length = 0;
    tg.mode.fail = 2; // оба чата ответили ошибкой
    const { orderId } = await placeOrder(shop, pid, { phone: '89160000002' });
    const failed = await waitFor(async () => (await outbox()).find((r) => r.order_id === orderId && r.attempts === 1 && !r.sent_at && r.error));
    assert.match(failed.error, /500/);
    assert.match(failed.error, /Internal Server Error/);
    assert.ok(new Date(failed.next_at) > new Date(), 'следующая попытка назначена на потом');
    // подошло время повтора
    await shop.db.query('UPDATE webshop.outbox SET next_at = NOW() WHERE id = $1', [failed.id]);
    await shop.services.notifier.run();
    const done = (await outbox()).find((r) => r.id === failed.id);
    assert.ok(done.sent_at, 'доставлено со второй попытки');
    assert.equal(done.attempts, 2);
    assert.equal(tg.calls.length, 4, 'две неудачные отправки и две успешные при повторе');
    assert.ok(tg.calls.slice(2).every((c) => /Новый заказ/.test(c.body.text)));
    await shop.services.notifier.run();
    assert.equal((await outbox()).find((r) => r.id === failed.id).attempts, 2, 'доставленное повторно не берётся');
  });

  test('один из чатов недоступен: доставлено - дубль в рабочий чат не отправляется', async () => {
    tg.calls.length = 0;
    tg.mode.body = null;
    // первый чат отвечает ошибкой, второй успешно: ровно одна ошибка, затем ок
    tg.mode.fail = 1;
    const { orderId } = await placeOrder(shop, pid, { phone: '89160000003' });
    const row = await waitFor(async () => (await outbox()).find((r) => r.order_id === orderId && r.sent_at));
    assert.equal(row.attempts, 1);
    assert.match(row.error, /500/, 'ошибка по недоступному чату записана');
    assert.equal(tg.calls.length, 2, 'каждому чату - одна попытка');
  });

  test('Telegram недоступен совсем: покупатель получает заказ, уведомление ждёт в очереди', async () => {
    const dead = await startShop('notify_dead', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111', TELEGRAM_API_URL: 'http://127.0.0.1:9' });
    try {
      const p = await addProduct(dead.db, { sku: 'ND-1_42', name: 'Кроссовки Nike Dead', price: 9000, qty: 3 });
      const { orderId } = await placeOrder(dead, p);
      const row = await waitFor(async () => (await dead.db.query('SELECT * FROM webshop.outbox WHERE order_id = $1', [orderId])).rows.find((r) => r.error));
      assert.equal(row.sent_at, null);
      assert.ok(row.attempts >= 1);
      assert.ok(!row.error.includes(TOKEN), 'токен бота не попадает в журнал ошибок');
      assert.equal((await dead.db.query('SELECT status FROM webshop.orders WHERE id = $1', [orderId])).rows[0].status, 'new');
    } finally { await dead.stop(); }
  });

  test('без настроек Telegram очередь не заводится, заказ оформляется', async () => {
    const off = await startShop('notify_off');
    try {
      const p = await addProduct(off.db, { sku: 'NO-1_42', name: 'Кроссовки Nike Off', price: 9000, qty: 3 });
      await placeOrder(off, p);
      assert.equal((await off.db.query('SELECT COUNT(*)::int AS n FROM webshop.outbox')).rows[0].n, 0);
      assert.equal(off.services.notifier.enabled(), false);
    } finally { await off.stop(); }
  });

  test('админка: состояние и кнопка «Отправить тестовое сообщение»', async () => {
    tg.calls.length = 0; tg.mode.fail = 0; tg.mode.body = null;
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/settings')).text;
    assert.match(page, /Telegram подключён/);
    assert.match(page, /Отправить тестовое сообщение/);
    assert.doesNotMatch(page, new RegExp(TOKEN.slice(0, 12)), 'токен в админке не показывается');
    const r = await a.c.post('/admin/notify/test', { _csrf: a.csrf });
    assert.equal(r.status, 302);
    assert.equal(tg.calls.length, 2);
    assert.match(tg.calls[0].body.text, /Проверка уведомлений/);
    const after = (await a.c.get('/admin/settings')).text;
    assert.match(after, /Тестовое сообщение отправлено/);
    // ошибка от Telegram (бот не в чате) показывается понятно
    tg.mode.status = 400; tg.mode.body = { ok: false, description: 'Bad Request: chat not found' };
    await a.c.post('/admin/notify/test', { _csrf: a.csrf });
    assert.match((await a.c.get('/admin/settings')).text, /chat not found/);
    tg.mode.body = null;
  });

  test('без настроек админка объясняет, как подключить', async () => {
    const off = await startShop('notify_off2');
    try {
      const a = await adminLogin(off.base, 'owner1', 'owner-pass-123');
      const page = (await a.c.get('/admin/settings')).text;
      assert.match(page, /Не настроены/);
      assert.match(page, /TELEGRAM_BOT_TOKEN/);
      const r = await a.c.post('/admin/notify/test', { _csrf: a.csrf });
      assert.equal(r.status, 302);
      assert.match((await a.c.get('/admin/settings')).text, /Telegram не настроен/);
    } finally { await off.stop(); }
  });
});
