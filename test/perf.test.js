'use strict';
// Скорость сайта: каталог без пауз на обновление, лёгкая выборка товаров партнёров, карта по кнопке, статика с кэшем.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.describe('каталог: обновление в фоне', () => {
  let shop, cat, realLoad;
  test.before(async () => {
    shop = await startShop('perfcat', { CATALOG_TTL: '1' });
    await addProduct(shop.db, { sku: 'PF-1_42', name: 'Кроссовки Nike Perf One', price: 9000, qty: 2 });
    cat = shop.services.catalog;
    realLoad = cat.load.bind(cat);
    await cat.ensure();
  });
  test.after(async () => { await shop.stop(); });

  // Подменяет загрузку на медленную: считает вызовы и держит её, пока не скажем
  const slowLoad = () => {
    const st = { calls: 0, release: null };
    const gate = new Promise((r) => { st.release = r; });
    cat.load = async () => { st.calls++; await gate; return realLoad(); };
    return st;
  };

  test('срок вышел сам по себе: запрос получает прежний каталог сразу, а обновление идёт в фоне', async () => {
    const st = slowLoad();
    try {
      cat.loadedAt = Date.now() - 5000;            // каталог устарел (TTL 1 с), но данные есть
      const t = Date.now();
      await cat.ensure();
      assert.ok(Date.now() - t < 200, 'ждать загрузки не пришлось');
      assert.equal(cat.models.length, 1, 'отдан прежний каталог');
      assert.equal(st.calls, 1, 'фоновое обновление запущено');
      await cat.ensure();
      await cat.ensure();
      assert.equal(st.calls, 1, 'одно обновление за раз, а не по запросу на каждый вход');
      st.release();
      await cat.pending;
      assert.ok(Date.now() - cat.loadedAt < 2000, 'после фонового обновления каталог снова свежий');
    } finally { cat.load = realLoad; }
  });

  test('после правки (заказ, цена в админке) следующий запрос ждёт свежих данных', async () => {
    const st = slowLoad();
    try {
      cat.invalidate();
      let done = false;
      const p = cat.ensure().then(() => { done = true; });
      await sleep(80);
      assert.equal(done, false, 'после invalidate() запрос дожидается загрузки');
      st.release();
      await p;
      assert.equal(st.calls, 1);
    } finally { cat.load = realLoad; }
  });

  test('invalidate() во время загрузки: получаем данные не старее правки', async () => {
    let n = 0;
    const gates = [];
    cat.load = async () => { const my = ++n; await new Promise((r) => gates.push(r)); return realLoad().then((x) => { x; return my; }); };
    try {
      cat.invalidate();
      const first = cat.ensure();                  // загрузка №1 началась
      await sleep(30);
      cat.invalidate();                            // правка пришла, пока №1 ещё идёт
      gates.shift()();                             // №1 завершилась: её данные могут быть до правки
      await sleep(60);
      assert.equal(n, 2, 'запущена вторая загрузка, уже после правки');
      gates.shift()();
      await first;
      assert.equal(cat.dirty, false);
      assert.equal(n, 2);
    } finally { cat.load = realLoad; }
  });

  test('фоновое обновление упало: сайт продолжает работать на прежнем каталоге и пробует снова не сразу', async () => {
    let calls = 0;
    cat.load = async () => { calls++; throw new Error('база недоступна'); };
    const warn = console.warn;
    const logged = [];
    console.warn = (...a) => logged.push(a.join(' '));
    try {
      cat.dirty = false;
      cat.retryAt = 0;
      cat.loadedAt = Date.now() - 5000;
      await cat.ensure();
      await sleep(50);
      assert.equal(cat.models.length, 1, 'прежний каталог на месте');
      assert.equal(calls, 1);
      assert.ok(logged.some((x) => /не удалось/.test(x)), 'причина записана в журнал');
      await cat.ensure(); await cat.ensure();
      assert.equal(calls, 1, 'повтор не раньше чем через несколько секунд, а не на каждый запрос');
    } finally { cat.load = realLoad; console.warn = warn; cat.retryAt = 0; }
  });

  test('первая загрузка и ошибка при пустом каталоге: запрос ждёт и получает ошибку, а не пустую витрину', async () => {
    const fresh = new (require('../src/catalog').Catalog)(shop.db, shop.cfg, shop.services.settings);
    fresh.load = async () => { throw new Error('база недоступна'); };
    await assert.rejects(fresh.ensure(), /база недоступна/);
  });
});

test('главная и каталог по-прежнему быстро открываются, пока каталог обновляется в фоне', async () => {
  const shop = await startShop('perfpage', { CATALOG_TTL: '1' });
  try {
    await addProduct(shop.db, { sku: 'PG-1_42', name: 'Кроссовки Nike Page One', price: 9000, qty: 2 });
    const cat = shop.services.catalog;
    await cat.ensure();
    const real = cat.load.bind(cat);
    cat.load = async () => { await sleep(600); return real(); };   // обновление идёт долго
    cat.loadedAt = Date.now() - 5000;
    const t = Date.now();
    const r = await client(shop.base).get('/catalog');
    assert.equal(r.status, 200);
    assert.match(r.text, /Nike Page One/);
    assert.ok(Date.now() - t < 450, `страница не ждала обновления каталога (${Date.now() - t} мс)`);
    cat.load = real;
    await cat.pending;
  } finally { await shop.stop(); }
});

test('каталог берёт из базы число фото партнёрских товаров, а не списки адресов (меньше трафика до базы)', async () => {
  const shop = await startShop('perfrows', { PARTNER_SYNC: 'off' });
  try {
    await shop.db.query(`INSERT INTO webshop.ext_products (source, path, section, title, price, in_stock, images)
      VALUES ('sergeev', 'p/a', 'tekhnika-apple', 'Смартфон Apple iPhone 16 128Gb Black', 70000, TRUE, '["https://x.test/1.jpg","https://x.test/2.jpg","https://x.test/3.jpg"]'::jsonb),
             ('sergeev', 'p/b', 'tekhnika-apple', 'Смартфон Apple iPhone 16 256Gb Black', 80000, TRUE, '[]'::jsonb)`);
    const rows = await shop.services.partner.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.image_count).sort(), [0, 3]);
    assert.equal(rows.every((r) => r.images === undefined), true, 'списка адресов в выборке нет');
    shop.services.catalog.invalidate(); await shop.services.catalog.ensure();
    const withPhotos = shop.services.catalog.allModels.find((m) => /128Gb/.test(m.title));
    assert.equal(withPhotos.photos.length, 3, 'фото на карточке по числу картинок');
    assert.equal(withPhotos.cover, withPhotos.photos[0]);
    assert.equal(shop.services.catalog.allModels.find((m) => /256Gb/.test(m.title)).photos.length, 0);
    const { buildExtModels } = require('../src/ext');
    const old = buildExtModels([{ id: 9, source: 'sergeev', path: 'p/c', title: 'Смартфон Apple iPhone 16', price: 1000, images: ['a', 'b'], in_stock: true }])[0];
    assert.equal(old.photos.length, 2, 'прежняя форма строки (список images) тоже понимается');
  } finally { await shop.stop(); }
});

test('настройки запуска: пул потоков, том с кэшем фото, сжатие zstd', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('Dockerfile'), /ENV UV_THREADPOOL_SIZE=8/);
  assert.match(read('Dockerfile'), /mkdir -p \/cache\/media && chown -R node:node \/cache/, 'папка принадлежит пользователю node, том унаследует права');
  const compose = read('docker-compose.yml');
  assert.match(compose, /MEDIA_CACHE_DIR: \/cache\/media/);
  assert.match(compose, /- media_cache:\/cache/);
  assert.match(compose, /\nvolumes:\n  caddy_data:\n  media_cache:/);
  assert.match(read('Caddyfile'), /encode zstd gzip/);
});

test('статика в боевом режиме кэшируется надолго', async () => {
  const shop = await startShop('perfstatic', { NODE_ENV: 'production', COOKIE_SECURE: 'false', PUBLIC_URL: 'https://shop.test' });
  try {
    const r = await fetch(`${shop.base}/static/css/shop.css`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /max-age=604800/);
    assert.match(r.headers.get('cache-control'), /immutable/);
  } finally { await shop.stop(); }
});
