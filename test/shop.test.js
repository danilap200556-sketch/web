'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct } = require('./helpers');

let shop;
let ids = {};

test.before(async () => {
  shop = await startShop('shop');
  const { db } = shop;
  ids.dunk41 = await addProduct(db, { sku: 'DD1391-100_41', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, qty: 2 });
  ids.dunk42 = await addProduct(db, { sku: 'DD1391-100_42', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, qty: 1, photo: false });
  ids.dunk43 = await addProduct(db, { sku: 'DD1391-100_43', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, qty: 0, photo: false });
  ids.nb = await addProduct(db, { sku: 'U9060SG_40', name: 'Кроссовки New Balance 9060 Magnet/Slate Grey', price: 16490, qty: 1 }); // последняя пара
  ids.hoodie = await addProduct(db, { sku: 'CH-001_M', name: 'Худи Carhartt WIP Chase', price: 8990, qty: 3 });
  ids.nophoto = await addProduct(db, { sku: 'NP-1_42', name: 'Кроссовки Puma Speedcat', price: 9990, qty: 2, photo: false });
  ids.noname = await addProduct(db, { sku: 'NONAME_40', name: 'NONAME_40', price: 100, qty: 5 });
  ids.crocs = await addProduct(db, { sku: 'CR-1_38', name: 'Сабо Crocs Classic Clog «Lemon»', price: 5990, qty: 4 });
});
test.after(async () => { await shop.stop(); });

const orderCount = async () => (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n;

test('главная открывается, показывает сезон и модели', async () => {
  const c = client(shop.base);
  const r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /data-season="(winter|spring|summer|autumn)"/);
  assert.match(r.text, /Nike Dunk Low|New Balance 9060|Crocs/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('каталог: модели склеены по размерам, без фото и без названия скрыты', async () => {
  const c = client(shop.base);
  const html = (await c.get('/catalog')).text;
  assert.match(html, /Dunk Low/);
  assert.equal((html.match(/href="\/p\/dd1391-100"/g) || []).length, 1, 'три размера - одна карточка');
  assert.doesNotMatch(html, /Speedcat/, 'модель без фото не показывается');
  assert.doesNotMatch(html, /NONAME/);
});

test('каталог: фильтры по бренду, размеру и цене, сортировка', async () => {
  const c = client(shop.base);
  assert.match((await c.get('/catalog?brand=Nike')).text, /Dunk Low/);
  assert.doesNotMatch((await c.get('/catalog?brand=Nike')).text, /href="\/p\/u9060sg"/);
  const s41 = (await c.get('/catalog?size=41')).text;
  assert.match(s41, /href="\/p\/dd1391-100"/);
  assert.doesNotMatch(s41, /href="\/p\/u9060sg"/, 'размера 41 у New Balance нет');
  assert.doesNotMatch((await c.get('/catalog?size=43')).text, /Dunk Low/, 'размер 43 раскуплен');
  assert.doesNotMatch((await c.get('/catalog?max=9000')).text, /Dunk Low/);
  assert.match((await c.get('/catalog?max=9000')).text, /Худи|Carhartt/);
  const asc = (await c.get('/catalog?sort=price_asc')).text;
  assert.ok(asc.indexOf('Crocs') < asc.indexOf('Dunk Low') || asc.indexOf('Classic Clog') < asc.indexOf('Dunk'), 'сначала дешёвые');
});

test('поиск: по бренду, артикулу, по-русски и в неправильной раскладке', async () => {
  const c = client(shop.base);
  const names = async (q) => JSON.parse((await c.get('/api/suggest?q=' + encodeURIComponent(q))).text).items.map((i) => i.title);
  assert.deepEqual(await names('dunk'), ['Nike Dunk Low']);
  assert.deepEqual(await names('DD1391'), ['Nike Dunk Low']);
  assert.deepEqual(await names('найк'), ['Nike Dunk Low'], 'русское написание бренда');
  assert.deepEqual(await names('тшлу'), ['Nike Dunk Low'], 'nike в русской раскладке');
  assert.deepEqual(await names('9060'), ['New Balance 9060 Magnet/Slate Grey']);
  assert.deepEqual(await names('несуществующее'), []);
  const count = JSON.parse((await c.get('/api/count?brand=Nike')).text);
  assert.equal(count.count, 1);
});

test('карточка модели: размеры, наличие, 404 для скрытых', async () => {
  const c = client(shop.base);
  const r = await c.get('/p/dd1391-100');
  assert.equal(r.status, 200);
  assert.match(r.text, /Panda/);
  assert.match(r.text, /name="pid" value="\d+"[^>]*data-size-label="41"/);
  assert.match(r.text, /disabled[^>]*data-size-label="43"/, 'раскупленный размер недоступен');
  assert.match(r.text, /application\/ld\+json/);
  assert.equal((await c.get('/p/np-1')).status, 404, 'без фото');
  assert.equal((await c.get('/p/net-takoj')).status, 404);
});

test('корзина: добавление, изменение количества, нельзя больше остатка', async () => {
  const c = client(shop.base);
  let r = await c.post('/cart/add', { pid: ids.dunk41 }, { headers: { 'x-fetch': '1', accept: 'application/json' } });
  assert.equal(JSON.parse(r.text).count, 1);
  r = await c.post('/cart/add', { pid: ids.dunk41 }, { headers: { 'x-fetch': '1', accept: 'application/json' } });
  assert.equal(JSON.parse(r.text).count, 2);
  r = await c.post('/cart/add', { pid: ids.dunk41 }, { headers: { 'x-fetch': '1', accept: 'application/json' } });
  assert.equal(r.status, 409, 'на складе только 2 пары');
  r = await c.post('/cart/add', { pid: ids.dunk43 }, { headers: { 'x-fetch': '1', accept: 'application/json' } });
  assert.equal(r.status, 409, 'размера нет в наличии');
  const page = await c.get('/cart');
  assert.match(page.text, /23\s?980/);
  await c.post('/cart/update', { pid: ids.dunk41, qty: 0 });
  assert.match((await c.get('/cart')).text, /В корзине ничего нет/);
});

test('оформление: ошибки показываются, заказ не создаётся', async () => {
  const c = client(shop.base);
  await c.post('/cart/add', { pid: ids.hoodie });
  const before = await orderCount();
  const r = await c.post('/checkout', { name: 'А', phone: '1', delivery: 'pickup', pay: 'online' });
  assert.equal(r.status, 422);
  assert.match(r.text, /обращаться/);
  assert.equal(await orderCount(), before);
});

test('оформление: заказ создан, товар в резерве, корзина очищена, ссылка закрыта ключом', async () => {
  const c = client(shop.base);
  await c.get('/'); // посетитель получает cookie
  await c.post('/cart/add', { pid: ids.hoodie, qty: 2 });
  await c.post('/cart/add', { pid: ids.hoodie });
  const checkout = await c.get('/checkout');
  const pointId = /name="point" value="(\d+)"/.exec(checkout.text)[1];
  const idem = /name="idem" value="([^"]+)"/.exec(checkout.text)[1];
  const form = { idem, name: 'Анна Петрова', phone: '+7 916 123-45-67', email: 'anna@example.com', delivery: 'pickup', point: pointId, pay: 'cod', consent: '1' };
  const r = await c.post('/checkout', form);
  assert.equal(r.status, 303);
  const m = /\/order\/(\d+)\?t=([\w-]+)/.exec(r.location);
  assert.ok(m, r.location);
  const [, number, token] = m;

  const o = (await shop.db.query('SELECT * FROM webshop.orders WHERE number = $1', [number])).rows[0];
  assert.equal(o.status, 'new');
  assert.equal(o.phone, '79161234567');
  assert.equal(Number(o.total), 8990 * 3);
  assert.equal(o.delivery_kind, 'pickup');
  const items = (await shop.db.query('SELECT * FROM webshop.order_items WHERE order_id = $1', [o.id])).rows;
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 3);
  assert.equal(items[0].size, 'M');
  assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.customers WHERE phone = $1', ['79161234567'])).rows[0].n, 1);

  // страница заказа: только с ключом
  assert.equal((await client(shop.base).get(`/order/${number}`)).status, 404);
  assert.equal((await client(shop.base).get(`/order/${number}?t=wrong`)).status, 404);
  const page = await client(shop.base).get(`/order/${number}?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Анна Петрова/);

  // повторная отправка той же формы не создаёт второй заказ
  const again = await c.post('/checkout', form);
  assert.ok([303, 302].includes(again.status));
  assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders WHERE phone = $1', ['79161234567'])).rows[0].n, 1);

  // товар в резерве: свободных худи не осталось
  const cat = await client(shop.base).get('/catalog?all=1');
  assert.doesNotMatch(cat.text, /Carhartt WIP Chase[\s\S]{0,400}?Новинка/, 'не должно быть свежего поступления');
  const p = await client(shop.base).get('/p/ch-001');
  assert.match(p.text, /Нет в наличии/);
});

test('последняя пара достаётся одному покупателю', async () => {
  const a = client(shop.base);
  const b = client(shop.base);
  await a.post('/cart/add', { pid: ids.nb });
  await b.post('/cart/add', { pid: ids.nb });
  const mk = async (c, phone) => {
    const html = (await c.get('/checkout')).text;
    return { idem: /name="idem" value="([^"]+)"/.exec(html)[1], name: 'Тест', phone, delivery: 'pickup', point: /name="point" value="(\d+)"/.exec(html)[1], pay: 'cod', consent: '1' };
  };
  const fa = await mk(a, '89000000001');
  const fb = await mk(b, '89000000002');
  const [ra, rb] = await Promise.all([a.post('/checkout', fa), b.post('/checkout', fb)]);
  assert.equal([ra, rb].filter((r) => r.status === 303).length, 1, 'оформлен ровно один заказ');
  const loser = ra.status === 303 ? rb : ra;
  assert.ok([302, 409].includes(loser.status), 'второму заказ не оформлен');
  const n = (await shop.db.query("SELECT COUNT(*)::int AS n FROM webshop.order_items WHERE product_id = $1", [ids.nb])).rows[0].n;
  assert.equal(n, 1);
});

test('гонка: два заказа на одну пару, посчитанные до записи, не проходят оба', async () => {
  const { createOrder } = require('../src/orders');
  const cartLib = require('../src/cart');
  const { catalog, db } = shop.services;
  const pid = await addProduct(db, { sku: 'RACE-1_42', name: 'Кроссовки Nike Race One', price: 5000, qty: 1 });
  await catalog.ensure();
  const priced = cartLib.price(catalog, [{ pid, qty: 1 }]);
  const form = (phone) => ({ name: 'Гонка', phone, email: '', comment: '', city: '', address: '', point: 'Магазин', door: false, pay: 'cod',
    delivery: { code: 'pickup', title: 'Самовывоз', kind: 'pickup' }, deliveryCost: 0, total: 5000 });
  const results = await Promise.allSettled([
    createOrder(db, { form: form('79000000011'), priced, catalog }),
    createOrder(db, { form: form('79000000012'), priced, catalog }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.match(lost.reason.message, /разобрали/);
});

test('защита: межсайтовый POST отклоняется, ловушка для ботов не создаёт заказ', async () => {
  const c = client(shop.base);
  const r = await c.post('/cart/add', { pid: ids.crocs }, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  const before = await orderCount();
  await c.post('/cart/add', { pid: ids.crocs });
  const bot = await c.post('/checkout', { website: 'http://spam', name: 'Бот', phone: '89000000009', delivery: 'pickup', pay: 'cod', consent: '1' });
  assert.equal(bot.status, 302);
  assert.equal(await orderCount(), before);
});

test('статистика: визиты считаются, боты и служебные запросы нет', async () => {
  await shop.services.tracker.flush();
  await shop.db.query('TRUNCATE webshop.visits');
  const human = client(shop.base);
  await human.get('/', { headers: { referer: 'https://yandex.ru/search?text=x' } });
  await human.get('/p/dd1391-100');
  await human.get('/catalog');
  await client(shop.base).get('/', { ua: 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  await client(shop.base).get('/healthz');
  await client(shop.base).get('/static/css/shop.css');
  await shop.services.tracker.flush();
  const { rows } = await shop.db.query('SELECT kind, source, device FROM webshop.visits ORDER BY id');
  assert.deepEqual(rows.map((r) => r.kind), ['page', 'product', 'page']);
  assert.equal(rows[0].source, 'search', 'откуда пришёл - по адресу страницы-источника');
  assert.equal(rows[0].device, 'desktop');
  assert.equal(rows[1].source, '', 'источник пишется только на первом просмотре визита');
  const vids = (await shop.db.query('SELECT COUNT(DISTINCT sid)::int AS n FROM webshop.visits')).rows[0].n;
  assert.equal(vids, 1, 'один визит');
});

test('sitemap и robots', async () => {
  const c = client(shop.base);
  const sm = await c.get('/sitemap.xml');
  assert.match(sm.text, /\/p\/dd1391-100/);
  assert.doesNotMatch(sm.text, /np-1/);
  assert.match((await c.get('/robots.txt')).text, /Disallow: \/admin/);
});

test('фото отдаются с кэшем, неверные размеры отклоняются', async () => {
  const c = client(shop.base);
  const pid = (await shop.db.query('SELECT id FROM product_photos LIMIT 1')).rows[0].id;
  const r = await c.get(`/media/p/${pid}/360.jpg`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/(jpeg|webp)/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal((await c.get(`/media/p/${pid}/999.jpg`)).status, 404);
  assert.equal((await c.get('/media/p/99999999/360.jpg')).status, 404);
  const etag = r.headers.get('etag');
  assert.equal((await c.get(`/media/p/${pid}/360.jpg`, { headers: { 'if-none-match': etag } })).status, 304);
});
