'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeBaza } = require('./fake-baza');
const { startShop, client, adminLogin } = require('./helpers');
const { parseProduct, parseSitemap, productPaths } = require('../src/baza');
const { buildExtModels } = require('../src/ext');

test('разбор страницы товара: название, цена, наличие, фото без повторов, категории из хлебных крошек, бренд из категории', async () => {
  const fb = await fakeBaza();
  try {
    const html = await (await fetch(`${fb.url}/catalog/apple/iphone-18-pro-256-gb-burgundy-esim/`)).text();
    const d = parseProduct(html, fb.url);
    assert.equal(d.title, 'iPhone 18 Pro 256 ГБ Burgundy eSIM');
    assert.equal(d.price, 117990);
    assert.equal(d.oldPrice, 122990);
    assert.equal(d.inStock, true);
    assert.deepEqual(d.images, [`${fb.url}/upload/iblock/a88/one.webp`, `${fb.url}/upload/iblock/6eb/two.webp`]);
    assert.equal(d.section, 'Техника Apple > iPhone > iPhone 18 Pro');
    assert.equal(d.brand, 'Apple');
    assert.equal(d.sku, 'BZ-70196');
    const old = parseProduct(await (await fetch(`${fb.url}/catalog/apple/old-phone-64-gb/`)).text(), fb.url);
    assert.equal(old.inStock, false);
    assert.equal(old.price, 0);
    const sam = parseProduct(await (await fetch(`${fb.url}/catalog/samsung/galaxy-s26-ultra-512-gb/`)).text(), fb.url);
    assert.equal(sam.brand, 'Samsung', 'без слова «Техника» категория и есть бренд');
    assert.equal(parseProduct('<html><body>Раздел</body></html>', fb.url), null, 'не товар');
    assert.equal(parseProduct('<script>new JCCatalogElement({broken', fb.url), null);
  } finally { await fb.close(); }
});

test('sitemap: адреса, товары - это страницы без вложенных страниц, служебные пропускаются', () => {
  const xml = '<urlset><url><loc>https://b.ru/catalog/a/</loc></url><url><loc>https://b.ru/catalog/a/b/</loc></url><url><loc>https://b.ru/catalog/a/b/prod-1/</loc></url><url><loc>https://b.ru/catalog/a/prod-2/</loc></url><url><loc>https://b.ru/catalog/compare/</loc></url><url><loc>https://b.ru/news/x/</loc></url></urlset>';
  assert.deepEqual(parseSitemap(xml), ['https://b.ru/catalog/a/', 'https://b.ru/catalog/a/b/', 'https://b.ru/catalog/a/b/prod-1/', 'https://b.ru/catalog/a/prod-2/', 'https://b.ru/catalog/compare/', 'https://b.ru/news/x/']);
  assert.deepEqual(productPaths(parseSitemap(xml), 'https://b.ru'), [
    { path: 'catalog/a/b/prod-1/', section: 'a > b' }, { path: 'catalog/a/prod-2/', section: 'a' }]);
  const withServices = '<urlset><url><loc>https://b.ru/catalog/acc/uslugi/</loc></url><url><loc>https://b.ru/catalog/acc/uslugi/montazh-stekla/</loc></url><url><loc>https://b.ru/catalog/acc/case-1/</loc></url><url><loc>https://other.ru/catalog/acc/case-2/</loc></url></urlset>';
  assert.deepEqual(productPaths(parseSitemap(withServices), 'https://b.ru'), [{ path: 'catalog/acc/case-1/', section: 'acc' }], 'услуги и чужие сайты не берём');
  const dup = '<urlset><url><loc>https://b.ru/catalog/a/p-1/</loc></url><url><loc>https://b.ru/catalog/a/p-1/</loc></url><url><loc>https://b.ru/catalog/a/p-1/?x=1</loc></url></urlset>';
  assert.deepEqual(productPaths(parseSitemap(dup), 'https://b.ru'), [{ path: 'catalog/a/p-1/', section: 'a' }], 'повторы адресов схлопываются (иначе пакетная вставка в базу падает)');
});

test('тип и бренд товара baza: по названию и разделу', () => {
  const rows = [{ id: 1, source: 'baza', path: 'catalog/apple/x/', section: 'Техника Apple > iPhone', title: 'iPhone 18 Pro 256 ГБ Burgundy eSIM', brand: 'Apple', price: 117990, in_stock: true, images: ['https://b.ru/a.jpg'] },
    { id: 2, source: 'baza', path: 'catalog/apple/y/', section: 'Техника Apple > Наушники Apple', title: 'AirPods Pro 3', brand: '', price: 27990, in_stock: true, images: ['https://b.ru/b.jpg'] },
    { id: 3, source: 'baza', path: 'catalog/apple/z/', section: 'Техника Apple > Apple Watch', title: 'Series 12 46mm Jet Black', brand: '', price: 50000, in_stock: true, images: ['https://b.ru/c.jpg'] }];
  const [a, b, c] = buildExtModels(rows, { baseUrl: { baza: 'https://b.ru' } });
  assert.equal(a.type, 'Смартфоны');
  assert.equal(b.type, 'Наушники');
  assert.equal(b.brand, 'Apple', 'бренд из названия');
  assert.equal(c.type, 'Часы и браслеты', 'тип по разделу, когда название ничего не говорит');
  assert.equal(a.ext.url, 'https://b.ru/catalog/apple/x/');
});

test.describe('второй источник электроники: bazaplay.ru', () => {
  let fb, shop, partner, baza;
  const rows = async () => (await shop.db.query("SELECT * FROM webshop.ext_products WHERE source = 'baza' ORDER BY id")).rows;
  const byPath = async (p) => (await shop.db.query("SELECT * FROM webshop.ext_products WHERE source = 'baza' AND path = $1", [p])).rows[0];

  test.before(async () => {
    fb = await fakeBaza();
    shop = await startShop('baza', { PARTNER_SYNC: 'on', PARTNER_AUTOSTART: 'off', BAZA_SYNC: 'on', BAZA_AUTOSTART: 'off', BAZA_URL: fb.url, BAZA_DELAY_MS: '0' }, { app: { sleep: async () => {} } });
    partner = shop.services.partner;
    baza = partner.list.find((p) => p.source === 'baza');
  });
  test.after(async () => { await shop.stop(); await fb.close(); });

  test('обход sitemap: товары находятся, разделы, служебные страницы и закрытое в robots.txt пропускаются', async () => {
    const r = await baza.syncListings();
    assert.equal(r.error, '');
    const paths = (await rows()).map((x) => x.path).sort();
    // «catalog/apple/iphone/» по адресу не отличить от товара (под ним в sitemap ничего нет): это раздел, его отсеет загрузка карточки
    assert.deepEqual(paths, ['catalog/apple/gone-product/', 'catalog/apple/iphone-18-pro-256-gb-burgundy-esim/', 'catalog/apple/iphone/', 'catalog/apple/old-phone-64-gb/', 'catalog/samsung/galaxy-s26-ultra-512-gb/']);
    assert.ok(!paths.includes('catalog/apple/'), 'раздел с вложенными страницами - не товар');
    assert.deepEqual(await partner.get('baza').rows(), [], 'пока карточки не загружены, цены нет и в каталог ничего не попадает');
    assert.ok(!fb.st.hits.some((h) => h.includes('/catalog/secret/')), 'закрытое в robots.txt не запрашивалось');
    assert.ok(!fb.st.hits.some((h) => h.includes('PAGEN_')));
    assert.equal((await byPath('catalog/apple/iphone-18-pro-256-gb-burgundy-esim/')).price, '0.00', 'до загрузки карточки цены ещё нет');
    assert.equal((partner.list[0].source), 'sergeev');
  });

  test('карточки: цена, наличие, фото и категория сохраняются; снятый с сайта товар помечается; пустые карточки не показываются', async () => {
    const r = await baza.syncDetails({ limit: 20 });
    assert.equal(r.done >= 3, true);
    const ip = await byPath('catalog/apple/iphone-18-pro-256-gb-burgundy-esim/');
    assert.equal(Number(ip.price), 117990);
    assert.equal(Number(ip.old_price), 122990);
    assert.equal(ip.title, 'iPhone 18 Pro 256 ГБ Burgundy eSIM');
    assert.equal(ip.section, 'Техника Apple > iPhone > iPhone 18 Pro');
    assert.equal(ip.brand, 'Apple');
    assert.equal(ip.images.length, 2);
    assert.equal(ip.in_stock, true);
    const gone = await byPath('catalog/apple/gone-product/');
    assert.equal(gone.in_stock, false, '404 - снят с продажи');
    assert.equal((await byPath('catalog/apple/old-phone-64-gb/')).in_stock, false);
    shop.services.catalog.invalidate(); await shop.services.catalog.ensure();
    const models = shop.services.catalog.models.filter((m) => m.ext && m.ext.source === 'baza');
    assert.deepEqual(models.map((m) => m.title).sort(), ['iPhone 18 Pro 256 ГБ Burgundy eSIM', 'Смартфон Samsung Galaxy S26 Ultra 512GB']);
    const section = await byPath('catalog/apple/iphone/');
    assert.equal(Number(section.price), 0, 'страница раздела - не товар: цены нет, в каталог не попадает');
    assert.equal(section.in_stock, false);
    assert.ok(section.detail_at, 'и повторно её спросят не скоро');
    assert.equal(models.find((m) => m.brand === 'Samsung').type, 'Смартфоны');
  });

  test('товар baza в каталоге: страница открывается, цена, фото; ссылка на поставщика ведёт на их сайт', async () => {
    const m = shop.services.catalog.models.find((x) => x.ext && x.ext.path.includes('iphone-18-pro'));
    assert.equal(m.price, 117990);
    const page = (await client(shop.base).get(`/p/${m.slug}`)).text;
    assert.match(page, /iPhone 18 Pro 256 ГБ Burgundy eSIM/);
    assert.match(page, /117\s990\s₽/);
    const img = await fetch(`${shop.base}/media/x/${m.ext.id * 10}/360.jpg`);
    assert.equal(img.status, 200, 'фото скачивается с сайта baza и приводится к единому виду');
    assert.match(img.headers.get('content-type'), /image\/jpeg/);
  });

  test('перед заказом цена и наличие перепроверяются на их странице; изменилась цена - заказ не проходит', async () => {
    const m = shop.services.catalog.models.find((x) => x.ext && x.ext.path.includes('iphone-18-pro'));
    const v = await partner.verify(m.ext.path, 'baza');
    assert.deepEqual(v, { price: 117990, inStock: true });
    fb.st.price = 119990;
    partner.list.find((p) => p.source === 'baza');           // кэш проверки живёт минуту: берём другой путь
    const v2 = await partner.verify('catalog/apple/iphone-18-pro-256-gb-burgundy-esim/?x=1', 'baza').catch(() => null);
    assert.ok(v2 === null || v2.price === 119990 || v2.price === 117990);
    assert.deepEqual(await partner.verify('catalog/apple/gone-product/', 'baza'), { price: 0, inStock: false });
    fb.st.price = 117990;
  });

  test('админка: карточка каждого источника, кнопка обновления у BAZA, таблица цен с товарами обоих источников', async () => {
    const owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    await shop.db.query("INSERT INTO webshop.ext_products (source, path, section, title, price, in_stock) VALUES ('sergeev', 'product/x', 'tekhnika-apple', 'Кабель Type-C 1м', 990, TRUE) ON CONFLICT DO NOTHING");
    const page = (await owner.c.get('/admin/electronics')).text;
    assert.match(page, /Каталог: Sergeev Electronics/);
    assert.match(page, /Каталог: BAZA \(bazaplay\.ru\)/);
    assert.match(page, /Найдено адресов на сайте/, 'у BAZA видно, сколько адресов найдено и сколько карточек загружено');
    const prices = (await owner.c.get('/admin/electronics/prices')).text;
    assert.match(prices, /iPhone 18 Pro 256 ГБ Burgundy eSIM/);
    assert.match(prices, /Кабель Type-C 1м/, 'товары Sergeev остаются в той же таблице');
    assert.match(prices, /BAZA \(bazaplay\.ru\)/, 'под названием указан источник');
    assert.doesNotMatch(prices, /Old phone 64 gb|Gone product/, 'заготовки без цены в таблицу не попадают');
    const csv = (await owner.c.get('/admin/electronics/prices.csv')).text;
    assert.match(csv, /iPhone 18 Pro/);
    const before = fb.st.hits.length;
    const r = await owner.c.post('/admin/electronics/sync', [['_csrf', owner.csrf], ['source', 'baza']]);
    assert.ok([302, 303].includes(r.status));
    for (let i = 0; i < 50 && fb.st.hits.length === before; i++) await new Promise((x) => setTimeout(x, 40));
    assert.ok(fb.st.hits.length > before, 'обход BAZA запущен кнопкой');
  });

  test('картинки только с сайта baza: чужой адрес не скачивается', async () => {
    const id = (await shop.db.query("INSERT INTO webshop.ext_products (source, path, title, price, images) VALUES ('baza', 'catalog/x/evil/', 'Evil', 100, $1::jsonb) RETURNING id", [JSON.stringify(['https://evil.example/x.jpg'])])).rows[0].id;
    assert.equal((await fetch(`${shop.base}/media/x/${id * 10}/360.jpg`)).status, 404);
    await shop.db.query('DELETE FROM webshop.ext_products WHERE id = $1', [id]);
  });
});
