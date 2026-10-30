'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin } = require('./helpers');

const { fakeCdek } = require('./fake-cdek');

const form = (co, extra = {}) => ({
  idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone: '89160000001', delivery: 'cdek', pay: 'online', consent: '1', ...extra,
});

test.describe('расчёт доставки по API СДЭК', () => {
  let shop, cdek, pid;
  async function cartWith(qty = 1) {
    const c = client(shop.base);
    await c.get('/');
    for (let i = 0; i < qty; i++) await c.post('/cart/add', { pid });
    return c;
  }
  const lastOrder = async () => (await shop.db.query('SELECT * FROM webshop.orders ORDER BY id DESC LIMIT 1')).rows[0];
  const json = async (c, path) => { const r = await c.get(path); return { status: r.status, body: r.text ? JSON.parse(r.text) : null }; };

  test.before(async () => {
    cdek = await fakeCdek();
    shop = await startShop('carriers', { CDEK_ACCOUNT: 'acc', CDEK_SECURE: 'sec', CDEK_API_URL: cdek.url, CDEK_FROM_CODE: '44' });
    pid = await addProduct(shop.db, { sku: 'CD-1_42', name: 'Кроссовки Nike Cargo', price: 11990, qty: 30 });
  });
  test.after(async () => { await shop.stop(); await cdek.close(); });

  test('подсказка города и один токен на все запросы', async () => {
    const c = await cartWith();
    const r = await json(c, '/api/delivery/cities?method=cdek&q=' + encodeURIComponent('Мос'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cities, [{ code: 44, name: 'Москва', region: '' }]);
    const s = await json(c, '/api/delivery/cities?method=cdek&q=' + encodeURIComponent('Сыз'));
    assert.deepEqual(s.body.cities, [{ code: 250, name: 'Сызрань', region: 'Самарская область' }]);
    assert.equal((await json(c, '/api/delivery/cities?method=cdek&q=%D0%9C')).body.cities.length, 0, 'меньше двух букв - без запроса к СДЭК');
    assert.equal(cdek.st.tokens, 1, 'токен получен один раз и переиспользован');
    assert.ok(cdek.st.calls.filter((x) => x.path !== '/v2/oauth/token').every((x) => /^Bearer tok-/.test(x.auth)));
  });

  test('пункты выдачи: поиск по адресу и названию, пункты без адреса скрыты', async () => {
    const c = await cartWith();
    const all = await json(c, '/api/delivery/points?method=cdek&city=44');
    assert.equal(all.body.points.length, 2, 'пункт без адреса не показывается');
    assert.deepEqual(all.body.points.map((p) => p.code), ['MSK1', 'MSK2']);
    const f = await json(c, '/api/delivery/points?method=cdek&city=44&q=' + encodeURIComponent('сокол'));
    assert.deepEqual(f.body.points.map((p) => p.code), ['MSK2']);
    assert.equal((await json(c, '/api/delivery/points?method=cdek&city=abc')).status, 400);
  });

  test('расчёт: самый дешёвый тариф нужного режима, вес по числу пар, цена округляется вверх', async () => {
    const c = await cartWith(1);
    const point = await json(c, '/api/delivery/quote?method=cdek&city=44&mode=point');
    assert.equal(point.status, 200);
    assert.equal(point.body.price, 200 + 2 * 50, '1 пара = 1,5 кг -> 2 кг; тариф 136 дешевле экспресса 483');
    assert.equal(point.body.tariff, 'Посылка склад-склад');
    assert.equal(point.body.etaMin, 3); assert.equal(point.body.etaMax, 5);
    assert.equal(point.body.total, 11990 + 300);
    const door = await json(c, '/api/delivery/quote?method=cdek&city=44&mode=door');
    assert.equal(door.body.price, Math.ceil(300 + 150.4), 'до двери - режим 3, 150,4 округляется до 151');
    const spb = await json(c, '/api/delivery/quote?method=cdek&city=137&mode=point');
    assert.equal(spb.body.price, 200 + 2 * 50 + 150, 'другой город - другая цена');
    const body = cdek.st.lastTariffBody;
    assert.equal(body.from_location.code, 44);
    assert.deepEqual(body.packages, [{ weight: 1500, length: 34, width: 22, height: 14 }]);
    const c2 = await cartWith(2);
    await json(c2, '/api/delivery/quote?method=cdek&city=44&mode=point');
    assert.deepEqual(cdek.st.lastTariffBody.packages, [{ weight: 3000, length: 34, width: 22, height: 28 }], 'две коробки: вес и высота складываются');
  });

  test('бесплатная доставка по порогу из админки действует и при расчёте по API', async () => {
    const c = await cartWith(2); // 23 980 ₽ при пороге 20 000
    const q = await json(c, '/api/delivery/quote?method=cdek&city=44&mode=point');
    assert.equal(q.body.free, true);
    assert.equal(q.body.price, 0);
    assert.equal(q.body.total, 23980);
  });

  test('заказ с расчётом по API: цена и пункт проверяет сервер, данные расчёта сохраняются', async () => {
    const c = await cartWith(1);
    const co = (await c.get('/checkout')).text;
    assert.match(co, /data-api="1"/, 'у СДЭК в форме включён расчёт по API');
    assert.match(co, /data-city-list/);
    const r = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'point', tcpoint_code: 'MSK2' }));
    assert.equal(r.status, 303, r.text.slice(0, 300));
    const o = await lastOrder();
    assert.equal(Number(o.delivery_cost), 300);
    assert.equal(Number(o.total), 11990 + 300);
    assert.equal(o.delivery_city, 'Москва');
    assert.match(o.delivery_point, /Ленинградский пр-т, 70 \(СДЭК: MSK2\)/);
    assert.equal(o.delivery_meta.carrier, 'cdek');
    assert.equal(o.delivery_meta.cityCode, 44);
    assert.equal(o.delivery_meta.pointCode, 'MSK2');
    assert.equal(o.delivery_meta.tariffCode, 136);
    assert.equal(o.delivery_meta.apiPrice, 300);
    // в админке на странице заказа видны данные расчёта
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get(`/admin/orders/${o.id}`)).text;
    assert.match(page, /Расчёт по API/);
    assert.match(page, /Посылка склад-склад: 300\s?₽, 3-5 дн\./);
    assert.match(page, /пункт MSK2/);
  });

  test('до двери по API: нужен адрес, цена считается по тарифу «склад-дверь»', async () => {
    const c = await cartWith(1);
    const co = (await c.get('/checkout')).text;
    const bad = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'door', address: '' }));
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Укажите адрес доставки/);
    const r = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'door', address: 'Тверская 7, кв. 5' }));
    assert.equal(r.status, 303, r.text.slice(0, 200));
    const o = await lastOrder();
    assert.equal(Number(o.delivery_cost), 451, '300 + 150,4 округляется вверх');
    assert.equal(o.delivery_door, true);
    assert.equal(o.delivery_address, 'Тверская 7, кв. 5');
    assert.equal(o.delivery_meta.tariffCode, 137);
  });

  test('подделка: пункт выдачи не из списка города отклоняется, цену клиент задать не может', async () => {
    const c = await cartWith(1);
    const co = (await c.get('/checkout')).text;
    const before = (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n;
    const wrong = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'point', tcpoint_code: 'SPB1' }));
    assert.equal(wrong.status, 422);
    assert.match(wrong.text, /Выберите пункт выдачи из списка/);
    const none = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'point', tcpoint_code: '' }));
    assert.equal(none.status, 422);
    // пытаемся навязать свою цену и название пункта: игнорируется, берётся расчёт сервера
    const r = await c.post('/checkout', form(co, { city: 'Москва', city_code: '44', mode: 'point', tcpoint_code: 'MSK1', price: '1', delivery_cost: '1', tcpoint: 'Мой пункт' }));
    assert.equal(r.status, 303);
    const o = await lastOrder();
    assert.equal(Number(o.delivery_cost), 300);
    assert.doesNotMatch(o.delivery_point, /Мой пункт/);
    assert.match(o.delivery_point, /MSK1/);
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n, before + 1);
  });

  test('сбой СДЭК: заказ оформляется по ценам из админки, текстом пункта', async () => {
    const c = await cartWith(1);
    const co = (await c.get('/checkout')).text;
    cdek.st.tariffFail = 5;
    const q = await json(c, '/api/delivery/quote?method=cdek&city=300&mode=point');
    assert.equal(q.status, 502);
    assert.equal(q.body.transient, true);
    cdek.st.tariffFail = 5;
    const r = await c.post('/checkout', form(co, { city: 'Тверь', city_code: '300', mode: 'point', tcpoint: 'Тверская, 7 (пункт СДЭК)' }));
    assert.equal(r.status, 303, r.text.slice(0, 200));
    const o = await lastOrder();
    assert.equal(Number(o.delivery_cost), 390, 'цена из админки (фиксированная)');
    assert.equal(o.delivery_point, 'Тверская, 7 (пункт СДЭК)');
    assert.equal(o.delivery_meta, null);
    cdek.st.tariffFail = 0;
  });

  test('СДЭК не возит в город: расчёт и заказ отклоняются с понятным текстом', async () => {
    const c = await cartWith(1);
    const co = (await c.get('/checkout')).text;
    cdek.st.noTariff = true;
    const q = await json(c, '/api/delivery/quote?method=cdek&city=250&mode=point');
    assert.equal(q.status, 422);
    assert.match(q.body.error, /не доставляет/);
    const r = await c.post('/checkout', form(co, { city: 'Сызрань', city_code: '250', mode: 'point', tcpoint_code: 'X' }));
    assert.equal(r.status, 422);
    assert.match(r.text, /не доставляет/);
    cdek.st.noTariff = false;
  });

  test('токен истёк: клиент получает новый и повторяет запрос', async () => {
    const c = await cartWith(1);
    const before = cdek.st.tokens;
    cdek.st.expireNext = true;
    const r = await json(c, '/api/delivery/quote?method=cdek&city=555&mode=point');
    assert.equal(r.status, 200);
    assert.ok(cdek.st.tokens > before, 'получен новый токен');
  });

  test('без ключей СДЭК API отключён, форма работает как раньше', async () => {
    const off = await startShop('carriers_off');
    try {
      await addProduct(off.db, { sku: 'OF-1_42', name: 'Кроссовки Nike Off', price: 9000, qty: 3 });
      const c = client(off.base);
      await c.get('/');
      const p = (await off.db.query("SELECT id FROM products WHERE sku = 'OF-1_42'")).rows[0].id;
      await c.post('/cart/add', { pid: p });
      assert.equal((await c.get('/api/delivery/cities?method=cdek&q=%D0%9C%D0%BE%D1%81')).status, 404);
      const co = (await c.get('/checkout')).text;
      assert.doesNotMatch(co, /data-api="1"/);
      const r = await c.post('/checkout', form(co, { city: 'Казань', mode: 'point', tcpoint: 'Пункт СДЭК на Баумана, 5' }));
      assert.equal(r.status, 303, r.text.slice(0, 200));
      assert.equal(Number((await off.db.query('SELECT delivery_cost FROM webshop.orders')).rows[0].delivery_cost), 390);
    } finally { await off.stop(); }
  });

  test('админка: «Проверить подключение» показывает шаги и ошибки', async () => {
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/delivery')).text;
    assert.match(page, /Расчёт по API/);
    assert.match(page, /Проверить подключение/);
    const r = await a.c.post('/admin/delivery/check/cdek', { _csrf: a.csrf });
    assert.equal(r.status, 200);
    assert.match(r.text, /Ключи интеграции/);
    assert.match(r.text, /токен получен/);
    assert.match(r.text, /Посылка склад-склад: 400 ₽/);
    assert.match(r.text, /найдено: 1/);
    // неверные ключи: понятная ошибка вместо пустого экрана
    const bad = await startShop('carriers_bad', { CDEK_ACCOUNT: 'acc', CDEK_SECURE: 'wrong', CDEK_API_URL: cdek.url, CDEK_FROM_CODE: '44' });
    try {
      const b = await adminLogin(bad.base, 'owner1', 'owner-pass-123');
      const rb = await b.c.post('/admin/delivery/check/cdek', { _csrf: b.csrf });
      assert.equal(rb.status, 200);
      assert.match(rb.text, /СДЭК не принял ключи/);
      assert.match(rb.text, /Неверные ключи/);
    } finally { await bad.stop(); }
  });
});
