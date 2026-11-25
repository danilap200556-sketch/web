'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin, fakeTelegram, loginAs, placeOrder } = require('./helpers');
const { tbankToken } = require('../src/payments');

const TOKEN = '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123';
const KEY = 'TK1';
const PASS = 'pw-secret-123';
let tg, shop, adm, pid, tgSeq = 4000;

test.before(async () => {
  tg = await fakeTelegram();
  shop = await startShop('custnotify', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111', TELEGRAM_API_URL: tg.url, PUBLIC_URL: 'https://shop.test', TBANK_TERMINAL_KEY: KEY, TBANK_PASSWORD: PASS, TRUST_PROXY: '1' });
  pid = await addProduct(shop.db, { sku: 'CN-1_42', name: 'Кроссовки Nike Notify «Customer»', price: 10000, qty: 100 });
  adm = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
});
test.after(async () => { await shop.stop(); await tg.close(); });

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('не дождались'); await new Promise((r) => setTimeout(r, 25)); }
};
const msgsTo = (chat) => tg.calls.filter((c) => c.url.endsWith('/sendMessage') && String(c.body.chat_id) === String(chat)).map((c) => c.body.text);
const outboxFor = async (orderId) => (await shop.db.query("SELECT * FROM webshop.outbox WHERE order_id = $1 AND kind = 'cust_status' ORDER BY id", [orderId])).rows;
const setStatus = (id, status) => adm.c.post(`/admin/orders/${id}/status`, { _csrf: adm.csrf, status });
// Покупатель с привязанным Telegram и его заказ
async function linkedOrder(phone, extra = {}) {
  const c = client(shop.base);
  const cust = await loginAs(shop, c, phone, { name: 'Анна' });
  const tgId = ++tgSeq;
  await shop.services.accounts.bindTelegram(cust.id, tgId);
  const o = await placeOrder(shop, pid, { c, phone, ...extra });
  const token = (await shop.db.query('SELECT token FROM webshop.orders WHERE id = $1', [o.orderId])).rows[0].token;
  return { cust, tgId, token, ...o };
}

test('смена статуса в админке: покупатель получает сообщение со статусом и ссылкой на заказ', async () => {
  const { tgId, number, orderId, token } = await linkedOrder('79160000701');
  assert.equal(msgsTo(tgId).length, 0, 'оформление заказа покупателю не пишем');
  await setStatus(orderId, 'packed');
  const [text] = await waitFor(async () => { const m = msgsTo(tgId); return m.length ? m : null; });
  assert.match(text, new RegExp(`Заказ №${number}: Собран`));
  assert.ok(text.includes(`https://shop.test/order/${number}?t=${token}`));
  await shop.db.query("UPDATE webshop.orders SET track_number = 'CDEK123456' WHERE id = $1", [orderId]);
  await setStatus(orderId, 'shipped');
  const all = await waitFor(async () => { const m = msgsTo(tgId); return m.length >= 2 ? m : null; });
  assert.match(all[1], /Отправлен/);
  assert.match(all[1], /CDEK123456/);
  await setStatus(orderId, 'shipped');                                // тот же статус ещё раз
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(msgsTo(tgId).length, 2, 'повтор не дублирует');
});

test('сигнал «отправь сейчас» не теряется, если пришёл посреди прохода: сообщение не ждёт следующего тика', async () => {
  const { tgId, orderId } = await linkedOrder('79160000712');
  await waitFor(async () => (msgsTo('111').length ? true : null));          // уведомление сотрудникам ушло, отправщик свободен
  const real = shop.db.query;
  const orig = real.bind(shop.db);
  let armed = true;
  // Выборка очереди вернула «пусто», и сразу после этого (проход ещё не закончен) появляется строка и приходит сигнал kick():
  // раньше такой сигнал отбрасывался, и сообщение ждало следующего тика таймера (30 секунд)
  shop.db.query = async (sql, params) => {
    const r = await orig(sql, params);
    if (armed && /UPDATE webshop\.outbox SET attempts/.test(sql) && r.rows.length === 0) {
      armed = false;
      await shop.services.notifier.enqueueCustomerStatus({ query: orig }, orderId, 'packed');
      shop.services.notifier.kick();
      await new Promise((x) => setImmediate(x));
      await new Promise((x) => setImmediate(x));
    }
    return r;
  };
  try {
    shop.services.notifier.kick();
    const [text] = await waitFor(async () => { const m = msgsTo(tgId); return m.length ? m : null; }, 2500);
    assert.match(text, /Собран/);
  } finally { shop.db.query = real; }
});

test('без привязанного Telegram и с выключенными уведомлениями ничего не ставится в очередь', async () => {
  const guest = await placeOrder(shop, pid, { phone: '79160000702' });
  await setStatus(guest.orderId, 'confirmed');
  assert.equal((await outboxFor(guest.orderId)).length, 0);
  const off = await linkedOrder('79160000703');
  await shop.services.accounts.setTelegramNotify(off.cust.id, false);
  await setStatus(off.orderId, 'confirmed');
  assert.equal((await outboxFor(off.orderId)).length, 0);
  // привязан Telegram, но заказ оформлен гостем: заказ не связан с аккаунтом - писать некому
  assert.equal(msgsTo(off.tgId).length, 0);
});

test('сотрудники по-прежнему получают свои уведомления о заказе', async () => {
  const { number } = await linkedOrder('79160000704');
  const staff = await waitFor(async () => { const m = msgsTo('111').filter((t) => t.includes(`№${number}`)); return m.length ? m : null; });
  assert.match(staff[0], /Новый заказ/);
});

test('покупатель заблокировал бота (403): запись закрыта, уведомления выключены, повторов нет', async () => {
  const { tgId, orderId, cust } = await linkedOrder('79160000705');
  tg.mode.blocked.add(String(tgId));
  await setStatus(orderId, 'confirmed');
  await waitFor(async () => (await outboxFor(orderId))[0]?.sent_at);
  const row = (await outboxFor(orderId))[0];
  assert.match(row.error, /blocked|заблокирова/i);
  assert.equal((await shop.services.accounts.byId(cust.id)).tg_notify, false);
  const attempts = row.attempts;
  await shop.services.notifier.run();
  assert.equal((await outboxFor(orderId))[0].attempts, attempts, 'не повторяется');
  tg.mode.blocked.clear();
});

test('сбой Telegram: сообщение повторяется по расписанию и доходит', async () => {
  const { tgId, orderId, number } = await linkedOrder('79160000706');
  await waitFor(async () => msgsTo('111').some((t) => t.includes(`№${number}`)));   // уведомление сотрудникам ушло: сбой достанется покупателю
  tg.mode.fail = 1;
  await setStatus(orderId, 'confirmed');
  await waitFor(async () => (await outboxFor(orderId))[0]?.error);
  assert.equal(msgsTo(tgId).length, 1, 'одна неудачная попытка (Telegram ответил 500)');
  assert.equal((await outboxFor(orderId))[0].sent_at, null);
  await shop.db.query("UPDATE webshop.outbox SET next_at = NOW() WHERE order_id = $1", [orderId]);
  await shop.services.notifier.run();
  assert.equal(msgsTo(tgId).length, 2, 'повтор дошёл');
  assert.ok((await outboxFor(orderId))[0].sent_at);
});

test('оплата картой (уведомление банка) тоже сообщает покупателю «Оплачен»', async () => {
  const { tgId, orderId, number } = await linkedOrder('79160000707', { pay: 'card' });
  const total = Number((await shop.db.query('SELECT total FROM webshop.orders WHERE id = $1', [orderId])).rows[0].total);
  await shop.db.query("INSERT INTO webshop.payments (order_id, provider, provider_order_id, provider_payment_id, amount, status) VALUES ($1, 'tbank', $2, '98765', $3, 'NEW')", [orderId, number, total]);
  const b = { TerminalKey: KEY, OrderId: number, Success: true, Status: 'CONFIRMED', PaymentId: 98765, ErrorCode: '0', Amount: Math.round(total * 100) };
  b.Token = tbankToken(b, PASS);
  const r = await fetch(`${shop.base}/pay/tbank/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal(await r.text(), 'OK');
  const [text] = await waitFor(async () => { const m = msgsTo(tgId); return m.length ? m : null; });
  assert.match(text, new RegExp(`Заказ №${number}: Оплачен`));
});

test('только токен бота, без чатов сотрудников: покупатели всё равно получают сообщения', async () => {
  const tg2 = await fakeTelegram();
  const only = await startShop('custnotify2', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_URL: tg2.url, TRUST_PROXY: '1' });
  try {
    const p = await addProduct(only.db, { sku: 'CN-2_42', name: 'Кроссовки Nike Only «Token»', price: 9000, qty: 10 });
    const c = client(only.base);
    const cust = await loginAs(only, c, '79160000708', { name: 'Анна' });
    await only.services.accounts.bindTelegram(cust.id, 4900);
    const o = await placeOrder(only, p, { c, phone: '79160000708' });
    const a = await adminLogin(only.base, 'owner1', 'owner-pass-123');
    await a.c.post(`/admin/orders/${o.orderId}/status`, { _csrf: a.csrf, status: 'confirmed' });
    await waitFor(async () => tg2.calls.some((x) => x.url.endsWith('/sendMessage') && String(x.body.chat_id) === '4900'));
    assert.equal(tg2.calls.filter((x) => x.url.endsWith('/sendMessage') && String(x.body.chat_id) !== '4900').length, 0, 'сотрудникам слать некуда');
  } finally { await only.stop(); await tg2.close(); }
});
