'use strict';
// Снимки с вывеской BAZA на корпусе компьютеров: находятся при проверке, скрываются в каталоге, остальные снимки товара остаются.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeBaza } = require('./fake-baza');
const { startShop, adminLogin } = require('./helpers');
const { extPhoto } = require('../src/ext');

test.describe('логотип BAZA на снимках: скрывается, остальные снимки товара показываются', () => {
  let fb, shop, baza;
  const START = 'catalog/kompyutery/igrovye_kompyutery/start/start-1-0-black/';
  const SILVER = 'catalog/kompyutery/igrovye_kompyutery/silver/silver-2-0-black/';
  const MOUSE = 'catalog/kompyutery/perifiriya/myshi/mouse-1/';
  const IPHONE = 'catalog/apple/iphone-18-pro-256-gb-burgundy-esim/';
  const row = async (p) => (await shop.db.query("SELECT * FROM webshop.ext_products WHERE source = 'baza' AND path = $1", [p])).rows[0];
  const fresh = async () => { shop.services.catalog.invalidate(); await shop.services.catalog.ensure(); return shop.services.catalog; };
  const imageHits = () => fb.st.hits.filter((h) => h.startsWith('/upload/'));

  test.before(async () => {
    fb = await fakeBaza({ pcs: true });
    shop = await startShop('bazalogo', { PARTNER_SYNC: 'on', PARTNER_AUTOSTART: 'off', BAZA_SYNC: 'on', BAZA_AUTOSTART: 'off', BAZA_URL: fb.url, BAZA_DELAY_MS: '0' }, { app: { sleep: async () => {} } });
    baza = shop.services.partner.get('baza');
    assert.equal((await baza.syncListings()).error, '');
    await baza.syncDetails({ limit: 30 });
  });
  test.after(async () => { await shop.stop(); await fb.close(); });

  test('до проверки показываются все снимки', async () => {
    const cat = await fresh();
    const start = cat.models.find((m) => m.ext && m.ext.path === START);
    assert.equal(start.photos.length, 3);
    assert.equal((await row(START)).hidden_images.length, 0);
  });

  test('проверка находит снимок с вывеской и ничего лишнего: чистые снимки, периферия, iPhone', async () => {
    const r = await baza.syncImageScan({ limit: 10 });
    assert.equal(r.scanned, 3, 'проверены два компьютера и мышь из раздела «Компьютеры»');
    assert.equal(r.hidden, 2);
    assert.deepEqual((await row(START)).hidden_images, [0]);
    assert.deepEqual((await row(SILVER)).hidden_images, [0]);
    assert.deepEqual((await row(MOUSE)).hidden_images, [], 'чистый снимок остаётся');
    assert.deepEqual((await row(IPHONE)).hidden_images, []);
    assert.ok(!imageHits().some((h) => h.includes('/a88/') || h.includes('/6eb/') || h.includes('/s1/')), 'снимки из других разделов (Apple, Samsung) не скачивались');
    assert.equal(imageHits().filter((h) => h.includes('/pc/')).length, 5, 'у трёх компьютеров и мыши: 3 + 1 + 1 снимка');
  });

  test('в каталоге у товара остаются только чистые снимки, а без единого чистого товар не показывается', async () => {
    const cat = await fresh();
    const start = cat.models.find((m) => m.ext && m.ext.path === START);
    const id = start.ext.id;
    assert.deepEqual(start.photos, [extPhoto(id, 1), extPhoto(id, 2)], 'нулевой снимок (с вывеской) убран, номера остальных прежние');
    assert.equal(start.cover, extPhoto(id, 1));
    assert.ok(!cat.models.some((m) => m.ext && m.ext.path === SILVER), 'у Silver единственный снимок с вывеской: без фото товар скрыт');
    const hidden = cat.allModels.find((m) => m.ext && m.ext.path === SILVER);
    assert.equal(hidden.hideReason, 'no_photo');
    assert.ok(cat.models.some((m) => m.ext && m.ext.path === MOUSE));
  });

  test('повторно ничего не качается, пока список снимков не изменился', async () => {
    const before = imageHits().length;
    const r = await baza.syncImageScan({ limit: 10 });
    assert.equal(r.scanned, 0);
    assert.equal(imageHits().length, before);
  });

  test('на сайте магазина поменяли снимки: товар проверяется заново и снимки возвращаются', async () => {
    const imgs = [`${fb.url}/upload/iblock/pc/clean-new.jpg`, `${fb.url}/upload/iblock/pc/clean-a.jpg`];
    await shop.db.query('UPDATE webshop.ext_products SET images = $2::jsonb WHERE id = $1', [(await row(START)).id, JSON.stringify(imgs)]);
    const r = await baza.syncImageScan({ limit: 10 });
    assert.equal(r.scanned, 1);
    assert.deepEqual((await row(START)).hidden_images, []);
    const cat = await fresh();
    assert.equal(cat.models.find((m) => m.ext && m.ext.path === START).photos.length, 2);
  });

  test('сайт магазина не отдал снимок: результат не записывается, повтор не раньше чем через 30 минут', async () => {
    const id = (await row(START)).id;
    const imgs = [`${fb.url}/upload/iblock/pc/logo-c.jpg`, `${fb.url}/upload/iblock/pc/clean-b.jpg`];
    fb.st.imageFail.add('/upload/iblock/pc/clean-b.jpg');
    await shop.db.query('UPDATE webshop.ext_products SET images = $2::jsonb WHERE id = $1', [id, JSON.stringify(imgs)]);
    const r = await baza.syncImageScan({ limit: 10 });
    assert.equal(r.scanned, 0, 'сбой сайта - не «снимков с логотипом нет»');
    assert.deepEqual((await row(START)).hidden_images, [], 'прежний результат не затёрт');
    const hits = imageHits().length;
    assert.equal((await baza.syncImageScan({ limit: 10 })).scanned, 0);
    assert.equal(imageHits().length, hits, 'до истечения получаса товар не трогаем');
    fb.st.imageFail.clear();
    await shop.db.query("UPDATE webshop.ext_products SET images_scan_at = NOW() - INTERVAL '31 minutes' WHERE id = $1", [id]);
    const r2 = await baza.syncImageScan({ limit: 10 });
    assert.equal(r2.scanned, 1);
    assert.deepEqual((await row(START)).hidden_images, [0]);
  });

  test('чужие адреса снимков не скачиваются и проверку не срывают', async () => {
    const id = (await row(START)).id;
    const imgs = ['https://evil.example/x.jpg', `${fb.url}/upload/iblock/pc/clean-a.jpg`];
    await shop.db.query('UPDATE webshop.ext_products SET images = $2::jsonb WHERE id = $1', [id, JSON.stringify(imgs)]);
    const r = await baza.syncImageScan({ limit: 10 });
    assert.equal(r.scanned, 1);
    assert.deepEqual((await row(START)).hidden_images, []);
  });

  test('состояние для админки: сколько снимков скрыто, у скольких товаров, у скольких не осталось фото', async () => {
    await shop.db.query('UPDATE webshop.ext_products SET images = $2::jsonb WHERE id = $1', [(await row(START)).id, JSON.stringify([`${fb.url}/upload/iblock/pc/logo-a.jpg`, `${fb.url}/upload/iblock/pc/clean-a.jpg`])]);
    await baza.syncImageScan({ limit: 10 });
    const st = await baza.status();
    assert.equal(st.scans, 'логотип BAZA');
    assert.equal(st.photos_hidden, 2, 'Start и Silver по одному снимку');
    assert.equal(st.products_hidden, 2);
    assert.equal(st.no_photo, 1, 'Silver остался без фото');
    const owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await owner.c.get('/admin/electronics')).text;
    assert.match(page, /Снимки с логотипом/);
    assert.match(page, /скрыто 2/);
    assert.equal((await shop.services.partner.get('sergeev').status()).scans, '', 'у Sergeev проверки снимков нет');
  });

  test('тик фоновой работы: после загрузки карточек проверяется один товар за раз', async () => {
    await shop.db.query("UPDATE webshop.ext_products SET images_scan = '' WHERE path = ANY($1)", [[START, SILVER, MOUSE]]);
    const before = (await shop.db.query("SELECT COUNT(*)::int AS n FROM webshop.ext_products WHERE source = 'baza' AND images_scan <> ''")).rows[0].n;
    await baza.tick();
    const after = (await shop.db.query("SELECT COUNT(*)::int AS n FROM webshop.ext_products WHERE source = 'baza' AND images_scan <> ''")).rows[0].n;
    assert.equal(after - before, 1, 'за один тик проверяется один товар');
  });
});
