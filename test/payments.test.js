'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startShop, client, addProduct, adminLogin } = require('./helpers');
const { tbankToken } = require('../src/payments');

const SBP = 'https://qr.nspk.ru/BS2A000N8IUJJRAH8FSP651VRVGNQ4G1';
const KEY = 'TestTermKey';
const PASS = 'test-terminal-password';

// Поддельный ТБанк: проверяет подпись запроса так же, как банк, и запоминает платежи
async function fakeBank() {
  const st = { inits: [], failNext: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && req.url === '/v2/Init') {
        const b = JSON.parse(raw);
        st.inits.push(b);
        if (b.Token !== tbankToken(b, PASS)) return send(200, { Success: false, ErrorCode: '9999', Message: 'Неверный токен' });
        if (st.failNext) { st.failNext = false; return send(200, { Success: false, ErrorCode: '8', Message: 'Терминал заблокирован' }); }
        const id = String(4300000000 + st.inits.length);
        return send(200, { Success: true, ErrorCode: '0', TerminalKey: b.TerminalKey, Status: 'NEW', PaymentId: id, OrderId: b.OrderId, Amount: b.Amount, PaymentURL: `https://securepay.test/new/${id}` });
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${server.address().port}/v2`, close: () => new Promise((r) => server.close(r)) };
}

async function placeOrder(shop, pid, { pay = 'sbp', delivery = 'pickup', phone = '89160000001' } = {}) {
  const c = client(shop.base);
  await c.get('/');
  await c.post('/cart/add', { pid });
  const co = (await c.get('/checkout')).text;
  const r = await c.post('/checkout', { idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone, delivery, point: /name="point" value="(\d+)"/.exec(co)[1], pay, consent: '1', city: 'Казань', tcpoint: 'Пункт СДЭК на Баумана, 5' });
  return { r, c, co };
}
const orderUrl = (r) => r.location;

test.describe('оплата: СБП, реквизиты, карта', () => {
  let shop, pid;
  test.before(async () => {
    shop = await startShop('pay_basic', { PUBLIC_URL: 'https://shop.test' });
    pid = await addProduct(shop.db, { sku: 'PY-1_42', name: 'Кроссовки Nike Payment «Test»', price: 11990, qty: 50 });
  });
  test.after(async () => { await shop.stop(); });

  test('на оформлении: СБП, перевод и «при получении»; карты нет, пока не подключён эквайринг', async () => {
    const c = client(shop.base);
    await c.get('/'); await c.post('/cart/add', { pid });
    const co = (await c.get('/checkout')).text;
    assert.match(co, /name="pay" value="sbp"/);
    assert.match(co, /name="pay" value="transfer"/);
    assert.match(co, /name="pay" value="cod"/);
    assert.doesNotMatch(co, /name="pay" value="card"/, 'карта без эквайринга не предлагается');
    assert.doesNotMatch(co, /name="pay" value="online"/, 'старый способ не предлагается');
    assert.match(co, /name="pay" value="sbp" checked/, 'по умолчанию СБП');
  });

  test('СБП: на странице заказа QR-код, кнопка со ссылкой НСПК, сумма и номер заказа', async () => {
    const { r, c } = await placeOrder(shop, pid, { pay: 'sbp' });
    assert.equal(r.status, 303);
    const page = (await c.get(orderUrl(r))).text;
    assert.match(page, /Оплата по СБП/);
    assert.match(page, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/, 'QR нарисован сервером, без внешних сервисов');
    assert.match(page, new RegExp(`href="${SBP}"`));
    assert.match(page, /11\s?990/);
    assert.match(page, /Заказ №\d+/);
    assert.match(page, /Открыть в приложении банка/);
  });

  test('перевод по реквизитам: ваши реквизиты с кнопками копирования и назначением платежа', async () => {
    const { r, c } = await placeOrder(shop, pid, { pay: 'transfer', phone: '89160000002' });
    const page = (await c.get(orderUrl(r))).text;
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    assert.match(page, /ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ УСАТОВ ЕГОР НИКОЛАЕВИЧ/);
    for (const v of ['616614137900', '40802810500009344859', '044525974', '30101810145250000974']) assert.match(page, new RegExp(v), v);
    assert.match(page, /АО «ТБанк»/);
    assert.match(page, new RegExp(`data-copy="Оплата заказа №${number}"`), 'назначение платежа копируется целиком');
    assert.match(page, /data-copy="40802810500009344859"/);
  });

  test('карту выбрать нельзя без эквайринга; старый «online» и чужие значения отклоняются; ТК только по предоплате', async () => {
    const before = (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n;
    for (const pay of ['card', 'online', 'bitcoin', '']) {
      const { r } = await placeOrder(shop, pid, { pay, phone: '89160000003' });
      assert.equal(r.status, 422, `pay=${pay}`);
      assert.match(r.text, /Выберите способ оплаты/);
    }
    const tc = await placeOrder(shop, pid, { pay: 'cod', delivery: 'cdek', phone: '89160000004' });
    assert.equal(tc.r.status, 422);
    assert.match(tc.r.text, /нужна предоплата/);
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n, before);
    const ok = await placeOrder(shop, pid, { pay: 'sbp', delivery: 'cdek', phone: '89160000005' });
    assert.equal(ok.r.status, 303, 'ТК с предоплатой по СБП проходит');
  });

  test('админка: реквизиты и ссылка СБП сохраняются, ошибки объясняются, чужая ссылка не принимается', async () => {
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/settings')).text;
    assert.match(page, /Оплата/);
    assert.match(page, /name="sbpUrl"/);
    assert.match(page, /Карта онлайн не подключена/);
    const good = { _csrf: a.csrf, sbpEnabled: 'on', sbpUrl: SBP, transferEnabled: 'on', name: 'ИП Тестов', inn: '616614137900', account: '40802810500009344859', bank: 'АО «ТБанк»', bik: '044525974', corr: '30101810145250000974' };
    const flash = async (form) => { const r = await a.c.post('/admin/settings/payment', form); assert.equal(r.status, 302); return (await a.c.get('/admin/settings')).text; };
    assert.match(await flash({ ...good, inn: '123' }), /ИНН: 10 цифр/);
    assert.match(await flash({ ...good, account: '4080281050000934485' }), /Расчётный счёт: 20 цифр/);
    assert.match(await flash({ ...good, bik: '04452597' }), /БИК: 9 цифр/);
    assert.match(await flash({ ...good, sbpUrl: 'https://evil.example/pay' }), /Ссылка СБП должна быть вида/);
    assert.match(await flash({ ...good, sbpUrl: 'http://qr.nspk.ru/ABCDEFGHIJKL' }), /Ссылка СБП должна быть вида/, 'только https');
    const saved = await flash({ ...good, name: 'ИП Тестов Иван' });
    assert.match(saved, /Настройки оплаты сохранены/);
    const { r, c } = await placeOrder(shop, pid, { pay: 'transfer', phone: '89160000006' });
    assert.match((await c.get(orderUrl(r))).text, /ИП Тестов Иван/);
    // вернуть как было
    await a.c.post('/admin/settings/payment', { ...good, name: 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ УСАТОВ ЕГОР НИКОЛАЕВИЧ' });
    // выключенный СБП исчезает с оформления
    await a.c.post('/admin/settings/payment', { ...good, sbpEnabled: '', name: 'ИП' });
    const c2 = client(shop.base); await c2.get('/'); await c2.post('/cart/add', { pid });
    assert.doesNotMatch((await c2.get('/checkout')).text, /name="pay" value="sbp"/);
    await a.c.post('/admin/settings/payment', { ...good, name: 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ УСАТОВ ЕГОР НИКОЛАЕВИЧ' });
  });
});

test.describe('карта онлайн через эквайринг ТБанка', () => {
  let shop, bank, pid;
  const post = (path, body) => fetch(shop.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const notify = (pay, extra = {}) => {
    const b = { TerminalKey: KEY, OrderId: pay.provider_order_id, Success: true, Status: 'CONFIRMED', PaymentId: Number(pay.provider_payment_id), ErrorCode: '0', Amount: Math.round(Number(pay.amount) * 100), CardId: 12345, Pan: '430000******0777', ExpDate: '1230', ...extra };
    b.Token = tbankToken(b, PASS);
    return b;
  };
  const payRow = async (orderId) => (await shop.db.query('SELECT * FROM webshop.payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])).rows[0];
  const orderRow = async (number) => (await shop.db.query('SELECT * FROM webshop.orders WHERE number = $1', [number])).rows[0];

  test.before(async () => {
    bank = await fakeBank();
    shop = await startShop('pay_card', { PUBLIC_URL: 'https://shop.test', TBANK_TERMINAL_KEY: KEY, TBANK_PASSWORD: PASS, TBANK_API_URL: bank.url, TBANK_TAXATION: 'usn_income' });
    pid = await addProduct(shop.db, { sku: 'PC-1_42', name: 'Кроссовки Nike Card «Test»', price: 11990, qty: 50 });
  });
  test.after(async () => { await shop.stop(); await bank.close(); });

  test('карта появляется на оформлении, платёж создаётся с подписью, суммой в копейках, адресами и чеком', async () => {
    const { r, c, co } = await placeOrder(shop, pid, { pay: 'card' });
    assert.match(co, /name="pay" value="card"/);
    assert.equal(r.status, 303);
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    const page = (await c.get(orderUrl(r))).text;
    assert.match(page, /Оплата картой/);
    const link = /href="(\/order\/\d+\/pay\/card\?t=[^"]+)"/.exec(page)[1];
    const go = await c.get(link);
    assert.equal(go.status, 303);
    assert.match(go.location, /^https:\/\/securepay\.test\/new\/43000000\d+$/, 'покупателя ведут на страницу банка');
    const init = bank.st.inits.at(-1);
    assert.equal(init.TerminalKey, KEY);
    assert.equal(init.Amount, 1199000, 'сумма в копейках');
    assert.equal(init.OrderId, number);
    assert.equal(init.NotificationURL, 'https://shop.test/pay/tbank/notify');
    assert.match(init.SuccessURL, new RegExp(`^https://shop\\.test/order/${number}\\?t=.+&paid=1$`));
    assert.match(init.FailURL, /&paid=0$/);
    assert.equal(init.Token, tbankToken(init, PASS), 'подпись запроса верна');
    assert.equal(init.Receipt.Taxation, 'usn_income');
    assert.equal(init.Receipt.Phone, '+79160000001');
    assert.equal(init.Receipt.Items.reduce((a, i) => a + i.Amount, 0), init.Amount, 'позиции чека в сумме дают сумму платежа');
    assert.equal(init.Receipt.Items[0].PaymentObject, 'commodity');
    const o = await orderRow(number);
    const pay = await payRow(o.id);
    assert.equal(pay.status, 'NEW');
    assert.equal(Number(pay.amount), 11990);
  });

  test('уведомление банка с верной подписью отмечает заказ оплаченным один раз, неверная подпись и чужая сумма - нет', async () => {
    const { r, c } = await placeOrder(shop, pid, { pay: 'card', phone: '89160000011' });
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    await c.get(/href="(\/order\/\d+\/pay\/card\?t=[^"]+)"/.exec((await c.get(orderUrl(r))).text)[1]);
    const o = await orderRow(number);
    const pay = await payRow(o.id);

    const forged = notify(pay); forged.Token = 'f'.repeat(64);
    assert.equal((await post('/pay/tbank/notify', forged)).status, 403);
    const wrongTerminal = notify(pay, { TerminalKey: 'Other' });
    assert.equal((await post('/pay/tbank/notify', wrongTerminal)).status, 403);
    assert.equal((await orderRow(number)).status, 'new', 'подделка заказ не оплачивает');

    const wrongAmount = notify(pay, { Amount: 100 });
    const rw = await post('/pay/tbank/notify', wrongAmount);
    assert.equal(rw.status, 200);
    assert.equal(await rw.text(), 'OK');
    assert.equal((await orderRow(number)).status, 'new', 'не та сумма - не оплачен');
    const ev = (await shop.db.query("SELECT text FROM webshop.order_events WHERE order_id = $1 ORDER BY id", [o.id])).rows.map((e) => e.text).join('|');
    assert.match(ev, /сумма .* не совпала/);

    const authorized = await post('/pay/tbank/notify', notify(pay, { Status: 'AUTHORIZED' }));
    assert.equal(await authorized.text(), 'OK');
    assert.equal((await orderRow(number)).status, 'new', 'AUTHORIZED - ещё не оплата');

    const good = await post('/pay/tbank/notify', notify(pay));
    assert.equal(good.status, 200);
    assert.equal(await good.text(), 'OK');
    assert.equal((await orderRow(number)).status, 'paid');
    assert.equal((await payRow(o.id)).status, 'CONFIRMED');
    const events = (await shop.db.query('SELECT text FROM webshop.order_events WHERE order_id = $1', [o.id])).rows.filter((e) => /Оплачено картой/.test(e.text));
    assert.equal(events.length, 1);
    await post('/pay/tbank/notify', notify(pay)); // банк повторяет уведомление
    assert.equal((await shop.db.query('SELECT text FROM webshop.order_events WHERE order_id = $1', [o.id])).rows.filter((e) => /Оплачено картой/.test(e.text)).length, 1, 'повтор ничего не дублирует');
    assert.match((await c.get(orderUrl(r))).text, /Оплата получена/);
  });

  test('сбой банка: покупатель возвращается на заказ с понятным текстом, повторная попытка получает новый номер платежа', async () => {
    const { r, c } = await placeOrder(shop, pid, { pay: 'card', phone: '89160000012' });
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    const link = /href="(\/order\/\d+\/pay\/card\?t=[^"]+)"/.exec((await c.get(orderUrl(r))).text)[1];
    bank.st.failNext = true;
    const bad = await c.get(link);
    assert.equal(bad.status, 303);
    assert.match(bad.location, /&payerr=1$/);
    assert.match((await c.get(bad.location)).text, /Не удалось открыть страницу оплаты картой/);
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.payments WHERE order_id = (SELECT id FROM webshop.orders WHERE number = $1)', [number])).rows[0].n, 0);
    const ok = await c.get(link);
    assert.match(ok.location, /^https:\/\/securepay\.test\//);
    const second = await c.get(link); // ещё одна попытка: новый платёж, номер с суффиксом
    assert.match(second.location, /^https:\/\/securepay\.test\//);
    assert.equal(bank.st.inits.at(-1).OrderId, `${number}-2`);
  });

  test('чужой или неверный токен заказа не открывает оплату; оплаченный заказ не платится повторно', async () => {
    const { r, c } = await placeOrder(shop, pid, { pay: 'card', phone: '89160000013' });
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    assert.equal((await client(shop.base).get(`/order/${number}/pay/card?t=wrong`)).status, 404);
    const o = await orderRow(number);
    await shop.db.query("UPDATE webshop.orders SET status = 'paid' WHERE id = $1", [o.id]);
    const link = /\/order\/\d+\?t=([^&]+)/.exec(r.location)[1];
    const res = await c.get(`/order/${number}/pay/card?t=${link}`);
    assert.equal(res.status, 303);
    assert.doesNotMatch(res.location, /securepay/, 'оплаченный заказ на оплату не отправляют');
  });

  test('админка: карточка «Оплата» показывает, что карта подключена', async () => {
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/settings')).text;
    assert.match(page, /Карта онлайн подключена/);
    assert.doesNotMatch(page, new RegExp(PASS), 'пароль терминала нигде не показывается');
  });
});
