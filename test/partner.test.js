'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin } = require('./helpers');
const { fakePartner } = require('./fake-partner');
const { parseListing, parseProduct, parseRobots, parsePrice, bestImages } = require('../src/partner');
const { EXT_BASE, buildExtModels, detectBrand, typeOfTitle, markup } = require('../src/ext');

test('разбор цены, робота и картинок', () => {
  assert.equal(parsePrice('130290 ₽ '), 130290);
  assert.equal(parsePrice('1 690 ₽'), 1690);
  assert.equal(parsePrice('от 12 990 ₽'), 12990);
  assert.equal(parsePrice('нет цены'), 0);
  const r = parseRobots('User-agent: Bad\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\nDisallow: /*?sort=\nDisallow: /search$\nAllow: /cart/free\nCrawl-delay: 2');
  assert.equal(r.delay, 2);
  assert.equal(r.allows('/tekhnika-apple?page=3'), true);
  assert.equal(r.allows('/cart'), false);
  assert.equal(r.allows('/cart/free'), true, 'более длинное правило Allow побеждает');
  assert.equal(r.allows('/aksessuary?sort=p.price'), false);
  assert.equal(r.allows('/search'), false);
  assert.equal(r.allows('/search/abc'), true, 'знак $ означает конец адреса');
  assert.deepEqual(bestImages(['https://x/a_1-100x100.jpg', 'https://x/a_1-1000x1000.jpg', 'https://x/a_1-500x500.jpg', 'https://x/b-500x500.jpg']), ['https://x/a_1-1000x1000.jpg', 'https://x/b-500x500.jpg']);
});

test('бренд, тип и наценка электроники', () => {
  assert.equal(detectBrand('Смартфон iPhone 17 Pro Max (Silver)'), 'Apple');
  assert.equal(detectBrand('Смартфон Samsung Galaxy A07s'), 'Samsung');
  assert.equal(detectBrand('Фен Dyson Supersonic HD16'), 'Dyson');
  assert.equal(detectBrand('Умные часы Redmi Watch 6'), 'Xiaomi');
  assert.equal(detectBrand('Непонятный товар', 'garmin'), 'Garmin');
  assert.equal(typeOfTitle('Смартфон Apple iPhone 18'), 'Смартфоны');
  assert.equal(typeOfTitle('Беспроводные наушники JBL Live 780NC'), 'Наушники');
  assert.equal(typeOfTitle('Умные часы Apple Watch'), 'Часы и браслеты');
  assert.equal(typeOfTitle('Кабель Type-C 1м'), 'Аксессуары');
  assert.equal(markup(99990, 0), 99990);
  assert.equal(markup(99990, 10), 109990, 'наценка округляется вверх до 10 ₽');
  assert.equal(markup(1000, 5), 1050);
});

test('разбор страницы категории и карточки товара партнёра', async () => {
  const fp = await fakePartner();
  try {
    const list = await (await fetch(fp.url + '/tekhnika-apple')).text();
    const { items, maxPage } = parseListing(list, fp.url);
    assert.equal(maxPage, 2);
    assert.equal(items.length, 2);
    assert.deepEqual({ ...items[0], image: undefined }, { path: 'product/apple-iphone-18-pro-256-black', title: 'Смартфон Apple iPhone 18 Pro 256 Gb (Black)', price: 99990, oldPrice: 109990, inStock: true, image: undefined });
    assert.match(items[0].image, /_1-260x260\.jpg$/, 'берётся первая картинка, а не заглушка');
    const p2 = parseListing(await (await fetch(fp.url + '/tekhnika-apple?page=2')).text(), fp.url);
    assert.equal(p2.items[0].inStock, false, 'статус «нет в наличии»');
    assert.equal(p2.items[1].oldPrice, 0, 'без скидки старой цены нет');
    const d = parseProduct(await (await fetch(fp.url + '/product/apple-iphone-18-pro-256-black')).text(), fp.url);
    assert.equal(d.price, 99990);
    assert.equal(d.inStock, true);
    assert.equal(d.sku, 'SE-apple-iphone-18-pro-256-black');
    assert.match(d.description, /^Смартфон Apple iPhone 18 Pro 256 Gb \(Black\)\. Подробное описание/);
    assert.doesNotMatch(d.description, /</, 'разметка из описания убрана');
    assert.equal(d.images.length, 2);
    assert.ok(d.images.every((u) => /-1000x1000\.jpg$/.test(u)), 'от каждого фото берётся самый крупный размер');
    assert.equal(parseProduct('<html><script type="application/ld+json">{битый</script></html>', fp.url), null);
  } finally { await fp.close(); }
});

test.describe('электроника партнёра: каталог, заказ, фото, админка', () => {
  let shop, fp, whPid, sleeps;
  const rows = async () => (await shop.db.query('SELECT * FROM webshop.ext_products ORDER BY id')).rows;
  const byPath = async (p) => (await shop.db.query('SELECT * FROM webshop.ext_products WHERE path = $1', [p])).rows[0];
  const meta = async () => JSON.parse((await shop.db.query("SELECT value FROM webshop.meta WHERE key = 'ext_listing'")).rows[0].value);

  test.before(async () => {
    fp = await fakePartner();
    sleeps = [];
    shop = await startShop('partner', { PARTNER_SYNC: 'on', PARTNER_AUTOSTART: 'off', PARTNER_URL: fp.url, PARTNER_SECTIONS: 'tekhnika-apple,garmin', PARTNER_DELAY_MS: '3000', PUBLIC_URL: 'https://shop.test' },
      { app: { sleep: async (ms) => { sleeps.push(ms); } } });
    whPid = await addProduct(shop.db, { sku: 'WH-1_42', name: 'Кроссовки Nike Warehouse «Test»', price: 9990, qty: 9 });
  });
  test.after(async () => { await shop.stop(); await fp.close(); });

  test('обход каталога: страницы, товары, цены, наличие; запросы идут с паузами и по правилам robots.txt', async () => {
    const r = await shop.services.partner.syncListings();
    assert.equal(r.error, '');
    assert.equal(r.pages, 3, 'Apple: 2 страницы, Garmin: 1');
    assert.equal(r.items, 6);
    const all = await rows();
    assert.equal(all.length, 6);
    const iphone = await byPath('product/apple-iphone-18-pro-256-black');
    assert.equal(Number(iphone.price), 99990); assert.equal(Number(iphone.old_price), 109990); assert.equal(iphone.in_stock, true);
    assert.equal(iphone.section, 'tekhnika-apple');
    assert.equal((await byPath('product/apple-mac-mini-m6')).in_stock, false);
    assert.ok(sleeps.filter((ms) => ms >= 2900).length >= 3, 'между запросами к партнёру выдерживается пауза 3 с: ' + sleeps.join(','));
    assert.ok(fp.st.calls.includes('/robots.txt'), 'правила robots.txt запрошены');
    assert.ok(fp.st.calls.every((u) => !/sort=|\/cart/.test(u)), 'запрещённые разделы не запрашивались');
    const m = await meta();
    assert.equal(m.pages, 3); assert.equal(m.error, '');
  });

  test('товары партнёра в каталоге: отдел «Электроника», фильтр по бренду и типу, карточка без размеров', async () => {
    const c = client(shop.base);
    const home = (await c.get('/')).text;
    assert.doesNotMatch(home, /nav__link--soon/, 'плашка «скоро» пропала: электроника появилась');
    const dept = (await c.get('/catalog?dept=elektronika')).text;
    assert.match(dept, /iPhone 18 Pro/);
    assert.match(dept, /Forerunner 975/);
    assert.match(dept, /\/media\/x\/\d+\/360\.jpg/, 'фото партнёра идут через наш сервер');
    assert.doesNotMatch(dept, /Warehouse/, 'товары склада в этом отделе не показываются');
    assert.match((await c.get('/catalog?dept=elektronika&brand=Garmin')).text, /Forerunner/);
    assert.doesNotMatch((await c.get('/catalog?dept=elektronika&brand=Garmin')).text, /iPhone/);
    assert.match((await c.get('/catalog?dept=elektronika&type=' + encodeURIComponent('Наушники'))).text, /AirPods Pro 3/);
    assert.match((await c.get('/catalog?q=airpods')).text, /AirPods Pro 3/, 'поиск находит электронику');
    assert.doesNotMatch((await c.get('/catalog?sale=1')).text, /iPhone 18 Pro/, 'зачёркнутая цена партнёра по умолчанию скидкой не показывается');
    await shop.services.settings.set({ electronics: { markupPct: 0, showOldPrice: true } });
    assert.match((await c.get('/catalog?sale=1')).text, /iPhone 18 Pro/, 'после включения в админке - показывается как скидка');
    const row = await byPath('product/apple-iphone-18-pro-256-black');
    const slug = /href="\/p\/(e\d+-apple-iphone[^"]+)"/.exec(dept)[1];
    const pdp = (await c.get('/p/' + slug)).text;
    assert.match(pdp, /99\s?990/);
    assert.match(pdp, /−9%/, 'скидка включена в админке: 99 990 вместо 109 990');
    assert.doesNotMatch(pdp, /Выберите размер/, 'электронике размер не нужен');
    assert.match(pdp, new RegExp(`name="pid" value="${EXT_BASE + row.id}" checked`));
    assert.match(pdp, /Sergeev Electronics/);
    assert.match(pdp, /Mac mini|iPhone/);
  });

  test('карточки догружаются порциями: описание, крупные фото, точная цена', async () => {
    const pending = (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.ext_products WHERE detail_at IS NULL')).rows[0].n; // часть карточек могла подгрузиться при просмотре товара
    const r = await shop.services.partner.syncDetails({ limit: 20 });
    assert.equal(r.done, pending);
    assert.ok(pending >= 4);
    const row = await byPath('product/apple-iphone-18-pro-256-black');
    assert.match(row.description, /Подробное описание/);
    assert.equal(row.images.length, 2);
    assert.match(row.images[0], /-1000x1000\.jpg$/);
    assert.equal(row.brand, 'Apple');
    const c = client(shop.base);
    const slug = /href="\/p\/(e\d+-apple-iphone[^"]+)"/.exec((await c.get('/catalog?dept=elektronika')).text)[1];
    assert.match((await c.get('/p/' + slug)).text, /быстрый процессор/);
    assert.equal((await shop.services.partner.syncDetails({ limit: 20 })).done, 0, 'уже загруженные повторно не берутся');
  });

  test('фото партнёра: отдаётся через сервер сжатым, чужие адреса не скачиваются', async () => {
    const row = await byPath('product/apple-airpods-pro-3');
    const r = await fetch(`${shop.base}/media/x/${row.id * 10}/360.jpg`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 200 && buf.length < 20000);
    assert.equal((await fetch(`${shop.base}/media/x/${row.id * 10}/777.jpg`)).status, 404, 'произвольная ширина не допускается');
    assert.equal((await fetch(`${shop.base}/media/x/${row.id * 10 + 7}/360.jpg`)).status, 404, 'нет такого фото');
    const evil = (await shop.db.query("INSERT INTO webshop.ext_products (source, path, title, price, images) VALUES ('sergeev', 'product/evil', 'Evil', 100, $1::jsonb) RETURNING id", [JSON.stringify(['https://evil.example/x.jpg'])])).rows[0].id;
    const before = fp.st.calls.length;
    assert.equal((await fetch(`${shop.base}/media/x/${evil * 10}/360.jpg`)).status, 404, 'картинка с чужого домена не скачивается');
    assert.equal(fp.st.calls.length, before);
    await shop.db.query('DELETE FROM webshop.ext_products WHERE id = $1', [evil]);
  });

  test('фото: сначала пробуются крупные размеры, при их отсутствии берётся миниатюра; отсутствующие запоминаются', async () => {
    const row = await byPath('product/apple-watch-s12');
    await shop.db.query("UPDATE webshop.ext_products SET images = $2::jsonb WHERE id = $1", [row.id, JSON.stringify([`${fp.url}/image/cache/catalog/import/w/w_1-260x260.jpg`])]);
    const p = shop.services.partner;
    const reqs = (from) => fp.st.calls.slice(from).filter((u) => u.startsWith('/image/'));
    let n = fp.st.calls.length;
    assert.match((await p.fetchImage(row.id, 0)).url, /w_1-1000x1000\.jpg$/, 'есть крупный размер - берётся он');
    assert.deepEqual(reqs(n), ['/image/cache/catalog/import/w/w_1-1000x1000.jpg']);
    fp.st.missingSizes.add('1000x1000');
    n = fp.st.calls.length;
    assert.match((await p.fetchImage(row.id, 0)).url, /w_1-500x500\.jpg$/, '1000 нет - берётся 500');
    fp.st.missingSizes.add('500x500');
    n = fp.st.calls.length;
    assert.match((await p.fetchImage(row.id, 0)).url, /w_1-260x260\.jpg$/, 'крупных нет - миниатюра');
    n = fp.st.calls.length;
    assert.match((await p.fetchImage(row.id, 0)).url, /260x260/);
    assert.deepEqual(reqs(n), ['/image/cache/catalog/import/w/w_1-260x260.jpg'], 'отсутствующие размеры повторно не запрашиваются');
    fp.st.missingSizes.clear();
  });

  test('просмотр товара запускает фоновую подгрузку его карточки (не чаще раза в 10 минут)', async () => {
    const row = await byPath('product/garmin-fenix-9');
    await shop.db.query('UPDATE webshop.ext_products SET detail_at = NULL, description = $2 WHERE id = $1', [row.id, '']);
    const slug = /href="\/p\/(e\d+-garmin-fenix-9)"/.exec((await client(shop.base).get('/catalog?dept=elektronika&all=1')).text)[1];
    const before = fp.st.calls.filter((u) => u === '/product/garmin-fenix-9').length;
    assert.equal((await client(shop.base).get('/p/' + slug)).status, 200);
    const done = await (async () => { for (let i = 0; i < 100; i++) { const r = await byPath('product/garmin-fenix-9'); if (r.detail_at) return r; await new Promise((x) => setTimeout(x, 20)); } return null; })();
    assert.ok(done && /Подробное описание/.test(done.description), 'карточка подгрузилась в фоне');
    assert.equal(fp.st.calls.filter((u) => u === '/product/garmin-fenix-9').length, before + 1);
    await client(shop.base).get('/p/' + slug);
    await new Promise((x) => setTimeout(x, 80));
    assert.equal(fp.st.calls.filter((u) => u === '/product/garmin-fenix-9').length, before + 1, 'повторный просмотр лишних запросов к партнёру не делает');
  });

  async function buy(c, pids, { pay = 'sbp', phone = '89160000021' } = {}) {
    await c.get('/');
    for (const pid of pids) assert.equal(JSON.parse((await c.post('/cart/add', { pid }, { headers: { accept: 'application/json', 'x-fetch': '1' } })).text).ok, true);
    const co = (await c.get('/checkout')).text;
    return c.post('/checkout', { idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone, delivery: 'pickup', point: /name="point" value="(\d+)"/.exec(co)[1], pay, consent: '1' });
  }

  test('заказ электроники: цена партнёра, без остатков склада, в очередь списания не попадает', async () => {
    const row = await byPath('product/apple-airpods-pro-3');
    const c = client(shop.base);
    const r = await buy(c, [EXT_BASE + row.id]);
    assert.equal(r.status, 303, r.text.slice(0, 300));
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    const o = (await shop.db.query('SELECT * FROM webshop.orders WHERE number = $1', [number])).rows[0];
    assert.equal(Number(o.total), 24990);
    const items = (await shop.db.query('SELECT * FROM webshop.order_items WHERE order_id = $1', [o.id])).rows;
    assert.equal(items.length, 1);
    assert.equal(items[0].product_id, EXT_BASE + row.id);
    assert.equal(items[0].sku, 'sergeev:product/apple-airpods-pro-3');
    assert.equal(items[0].size, '');
    assert.ok(items[0].photo_id < 0, 'фото партнёра хранится отрицательным номером');
    const page = (await c.get(r.location)).text;
    assert.match(page, /AirPods Pro 3/);
    assert.doesNotMatch(page, /Размер:/);
    assert.match(page, /\/media\/x\/\d+\/360\.jpg/);
    // собран: товар не со склада, в очередь «Склада» не встаёт
    await shop.db.query("UPDATE webshop.orders SET status = 'packed', updated_at = NOW() WHERE id = $1", [o.id]);
    await shop.services.writeoff.sync();
    assert.equal((await shop.db.query("SELECT COUNT(*)::int AS n FROM order_writeoffs WHERE order_ref = $1", [number])).rows[0].n, 0);
    // админка: пометка «партнёр» и ссылка на товар
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const op = (await a.c.get(`/admin/orders/${o.id}`)).text;
    assert.match(op, /партнёр/);
    assert.match(op, /товары партнёра/);
    assert.match(op, new RegExp(`${fp.url}/product/apple-airpods-pro-3`));
  });

  test('смешанный заказ: на склад уходит только обувь со склада, партнёрский товар не резервирует склад', async () => {
    const row = await byPath('product/garmin-forerunner-975');
    const c = client(shop.base);
    const r = await buy(c, [whPid, EXT_BASE + row.id], { phone: '89160000022' });
    assert.equal(r.status, 303, r.text.slice(0, 200));
    const number = /\/order\/(\d+)/.exec(r.location)[1];
    const o = (await shop.db.query('SELECT id FROM webshop.orders WHERE number = $1', [number])).rows[0];
    await shop.db.query("UPDATE webshop.orders SET status = 'packed', updated_at = NOW() WHERE id = $1", [o.id]);
    await shop.services.writeoff.sync();
    const q = (await shop.db.query("SELECT lines FROM order_writeoffs WHERE order_ref = $1", [number])).rows[0];
    assert.ok(q, 'заказ встал в очередь списания');
    assert.deepEqual(q.lines.map((l) => l.key), ['WH-1_42'], 'в очереди только позиция со склада');
  });

  test('перед заказом цена и наличие перепроверяются у партнёра: изменилась цена или нет в наличии - заказ не оформляется', async () => {
    const row = await byPath('product/garmin-fenix-9');
    const pid = EXT_BASE + row.id;
    const before = (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n;
    fp.st.productPrice = { 'garmin-fenix-9': 94990 };
    const c = client(shop.base);
    const r = await buy(c, [pid], { phone: '89160000023' });
    assert.equal(r.status, 409);
    assert.match(r.text, /изменилась цена у поставщика/);
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n, before, 'заказ не создан');
    assert.equal(Number((await byPath('product/garmin-fenix-9')).price), 94990, 'новая цена сохранена в каталоге');
    fp.st.productPrice = {};
    const row2 = await byPath('product/apple-iphone-18-pro-256-black'); // у этого товара проверки ещё не было (результат проверки живёт минуту)
    fp.st.productStock = { 'apple-iphone-18-pro-256-black': false };
    const c2 = client(shop.base);
    const r2 = await buy(c2, [EXT_BASE + row2.id], { phone: '89160000024' });
    assert.equal(r2.status, 302, 'товара уже нет: покупателя возвращают в корзину');
    assert.equal(r2.location, '/cart');
    assert.match((await c2.get('/cart')).text, /Этого товара уже нет в наличии/);
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.orders')).rows[0].n, before, 'заказ не создан');
    fp.st.productStock = {};
  });

  test('сайт партнёра недоступен при проверке: заказ принимается по последним данным', async () => {
    const row = await byPath('product/apple-watch-s12');
    fp.st.failPaths.set('/product/apple-watch-s12', 5);
    const c = client(shop.base);
    const r = await buy(c, [EXT_BASE + row.id], { phone: '89160000025' });
    assert.equal(r.status, 303, r.text.slice(0, 200));
  });

  test('исчезнувшие из выдачи товары снимаются с продажи; сбой сайта партнёра обход прерывает, данные не теряются', async () => {
    fp.st.sections['tekhnika-apple'] = fp.st.sections['tekhnika-apple'].filter((p) => p.slug !== 'apple-airpods-pro-3');
    const r = await shop.services.partner.syncListings();
    assert.equal(r.error, '');
    assert.equal((await byPath('product/apple-airpods-pro-3')).in_stock, false, 'товара больше нет в выдаче партнёра');
    const keep = (await rows()).length;
    fp.st.failPaths.set('/garmin', 50);
    sleeps.length = 0;
    const bad = await shop.services.partner.syncListings();
    assert.match(bad.error, /HTTP 500/);
    assert.equal((await rows()).length, keep, 'при сбое ничего не удалено');
    assert.ok(sleeps.filter((ms) => ms >= 15000).length >= 3, 'при ошибках сервера ждём и повторяем: ' + sleeps.join(','));
    assert.match((await meta()).error, /HTTP 500/);
    fp.st.failPaths.clear();
  });

  test('robots.txt партнёра запрещает раздел - он не запрашивается', async () => {
    const before = fp.st.calls.length;
    const p = require('../src/partner').createPartner({ db: shop.db, cfg: { ...shop.cfg, partner: { ...shop.cfg.partner, sections: ['private-section'], delayMs: 0 } }, sleep: async () => {}, log: { warn() {} } });
    const r = await p.syncListings();
    assert.match(r.error, /robots\.txt партнёра не разрешает/);
    assert.deepEqual(fp.st.calls.slice(before).filter((u) => /private-section/.test(u)), [], 'запрещённый адрес не запрашивался');
  });

  test('админка «Электроника»: состояние, наценка пересчитывает цены, роль «редактор» имеет доступ', async () => {
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/electronics')).text;
    assert.match(page, /Sergeev Electronics/);
    assert.match(page, /синхронизация включена/);
    assert.match(page, /Товаров в каталоге/);
    assert.match(page, /Обновить каталог сейчас/);
    const r = await a.c.post('/admin/electronics/markup', { _csrf: a.csrf, markupPct: '10' });
    assert.equal(r.status, 302);
    assert.match((await a.c.get('/admin/electronics')).text, /Наценка сохранена/);
    const dept = (await client(shop.base).get('/catalog?dept=elektronika')).text;
    assert.match(dept, /109\s?990/, '99 990 + 10% = 109 989 -> 109 990 ₽');
    assert.match((await (async () => { await a.c.post('/admin/electronics/markup', { _csrf: a.csrf, markupPct: '-5' }); return a.c.get('/admin/electronics'); })()).text, /число от 0 до 100/);
    await a.c.post('/admin/electronics/markup', { _csrf: a.csrf, markupPct: '0' });
    assert.doesNotMatch((await client(shop.base).get('/catalog?sale=1')).text, /iPhone 18 Pro/, 'форма без галочки выключает показ скидки партнёра');
    assert.match((await a.c.get('/admin')).text, /Электроника/, 'пункт меню есть');
  });
});
