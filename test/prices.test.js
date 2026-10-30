'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addSitePrice, ymd, adminLogin } = require('./helpers');
const { sitePrice } = require('../src/model');

const nb = (s) => s.replace(/ /g, ' ');

test('сайт: цена модели - из цены сайта, скидка действует по датам включительно', () => {
  const sp = { price: 10000, salePrice: 8000, from: '2026-11-01', to: '2026-11-10' };
  assert.deepEqual(sitePrice(sp, '2026-10-31'), { price: 10000, oldPrice: 0, discount: 0, saleTo: '' }, 'до начала');
  assert.equal(sitePrice(sp, '2026-11-01').price, 8000, 'первый день включительно');
  assert.equal(sitePrice(sp, '2026-11-10').price, 8000, 'последний день включительно');
  assert.equal(sitePrice(sp, '2026-11-11').price, 10000, 'после окончания');
  assert.deepEqual(sitePrice(sp, '2026-11-05'), { price: 8000, oldPrice: 10000, discount: 20, saleTo: '2026-11-10' });
  assert.equal(sitePrice({ price: 10000, salePrice: 7000, from: '', to: '' }, '2030-01-01').price, 7000, 'без границ - всегда');
  assert.equal(sitePrice({ price: 10000, salePrice: 10000, from: '', to: '' }, '2026-11-05').oldPrice, 0, 'скидка не меньше цены - не скидка');
  assert.equal(sitePrice({ price: 10000, salePrice: 12000, from: '', to: '' }, '2026-11-05').price, 10000);
  assert.equal(sitePrice({ price: 0, salePrice: 100, from: '', to: '' }, '2026-11-05'), null, 'нет цены сайта - берётся цена склада');
  assert.equal(sitePrice(undefined, '2026-11-05'), null);
});

test.describe('витрина с ценами сайта', () => {
  let shop;
  const ids = {};
  test.before(async () => {
    shop = await startShop('prices');
    const { db } = shop;
    // цена склада 10 000, у большого размера 11 000 - без цены сайта действует цена каждого размера
    ids.plain41 = await addProduct(db, { sku: 'PL-1_41', name: 'Кроссовки Nike Plain One', price: 10000, qty: 2 });
    ids.plain42 = await addProduct(db, { sku: 'PL-1_42', name: 'Кроссовки Nike Plain One', price: 11000, qty: 2, photo: false });
    ids.over41 = await addProduct(db, { sku: 'OV-1_41', name: 'Кроссовки Nike Override One', price: 10000, qty: 2 });
    ids.over42 = await addProduct(db, { sku: 'OV-1_42', name: 'Кроссовки Nike Override One', price: 11000, qty: 2, photo: false });
    ids.sale = await addProduct(db, { sku: 'SA-1_42', name: 'Кроссовки adidas Sale One', price: 12000, qty: 3 });
    ids.sched = await addProduct(db, { sku: 'SC-1_42', name: 'Кроссовки adidas Scheduled One', price: 9000, qty: 3 });
    ids.ended = await addProduct(db, { sku: 'EN-1_42', name: 'Кроссовки adidas Ended One', price: 9500, qty: 3 });
    ids.today = await addProduct(db, { sku: 'TD-1_42', name: 'Кроссовки adidas Today One', price: 9100, qty: 3 });
    ids.bad = await addProduct(db, { sku: 'BD-1_42', name: 'Кроссовки adidas Bad One', price: 9200, qty: 3 });
    await addSitePrice(db, 'OV-1', { price: 13990 });
    await addSitePrice(db, 'SA-1', { price: 15990, sale: 12790, from: ymd(-1), to: ymd(5) });
    await addSitePrice(db, 'SC-1', { price: 11990, sale: 8990, from: ymd(1), to: ymd(9) });
    await addSitePrice(db, 'EN-1', { price: 12490, sale: 9990, from: ymd(-20), to: ymd(-1) });
    await addSitePrice(db, 'TD-1', { price: 10990, sale: 7990, from: ymd(0), to: ymd(0) });
    await addSitePrice(db, 'BD-1', { price: 10190, sale: 10190 });
  });
  test.after(async () => { await shop.stop(); });

  const page = async (path) => nb((await client(shop.base).get(path)).text);
  // Блок покупки на карточке модели: цена, скидка, размеры (без «Похожих моделей» ниже, где могут быть чужие скидки)
  const buy = async (path) => { const h = await page(path); const i = h.indexOf('class="buy"'); return h.slice(i, h.indexOf('<ul class="perks"', i)); };

  test('без цены сайта - цена склада, у каждого размера своя', async () => {
    const html = await buy('/p/pl-1');
    assert.match(html, /10 000 ₽/);
    assert.doesNotMatch(html, /price-old/);
    const m = shop.services.catalog.bySlug.get('pl-1');
    assert.equal(m.priceSource, 'warehouse');
    assert.deepEqual(m.sizes.map((s) => s.price), [10000, 11000]);
  });

  test('цена сайта - одна на все размеры и главнее цены склада', async () => {
    const html = await buy('/p/ov-1');
    assert.match(html, /13 990 ₽/);
    assert.doesNotMatch(html, /11 000 ₽|10 000 ₽/);
    const m = shop.services.catalog.bySlug.get('ov-1');
    assert.equal(m.priceSource, 'site');
    assert.deepEqual(m.sizes.map((s) => s.price), [13990, 13990]);
    assert.match(await page('/p/ov-1'), /"price":"13990"/, 'в разметке товара цена сайта');
  });

  test('скидка действует: новая цена, старая зачёркнута, процент, срок', async () => {
    const html = await buy('/p/sa-1');
    assert.match(html, /price--sale[^>]*>12 790 ₽/);
    assert.match(html, /price-old[^>]*>15 990 ₽/);
    assert.match(html, /−20%/);
    const end = ymd(5).split('-').reverse().join('.');
    assert.ok(html.includes('Скидка действует до ' + end), 'срок скидки показан');
    const full = await page('/p/sa-1');
    assert.match(full, /"price":"12790"/);
    assert.match(full, new RegExp(`"priceValidUntil":"${ymd(5)}"`));
  });

  test('скидка ещё не началась или уже закончилась - обычная цена; граничные дни включены', async () => {
    assert.match(await buy('/p/sc-1'), /11 990 ₽/);
    assert.doesNotMatch(await buy('/p/sc-1'), /price-old/);
    assert.match(await buy('/p/en-1'), /12 490 ₽/);
    assert.doesNotMatch(await buy('/p/en-1'), /price-old/);
    const today = await buy('/p/td-1');
    assert.match(today, /price--sale[^>]*>7 990 ₽/, 'скидка с сегодняшнего дня по сегодняшний - действует');
  });

  test('некорректная скидка (не меньше цены) не применяется', async () => {
    const html = await buy('/p/bd-1');
    assert.match(html, /10 190 ₽/);
    assert.doesNotMatch(html, /price-old/);
  });

  test('каталог: бирка скидки, фильтр «со скидкой», сортировка по размеру скидки, ссылка в шапке', async () => {
    const all = await page('/catalog?sort=discount');
    assert.match(all, /badge--sale[^>]*>−20%/);
    const sale = await page('/catalog?sale=1&sort=discount');
    assert.match(sale, /Sale One/);
    assert.match(sale, /Today One/);
    assert.doesNotMatch(sale, /Override One|Plain One|Scheduled One|Ended One|Bad One/);
    assert.ok(sale.indexOf('Today One') < sale.indexOf('Sale One'), 'сначала где скидка больше (27% против 20%)');
    assert.match(sale, /<h1>Скидки<\/h1>/);
    const home = await page('/');
    assert.match(home, /href="\/catalog\?sale=1&amp;sort=discount">Скидки/);
  });

  test('цены в фильтре и сортировке считаются по цене, которую увидит покупатель', async () => {
    const cheap = await page('/catalog?max=8000');
    assert.match(cheap, /Today One/, '7 990 после скидки укладывается в 8000');
    assert.doesNotMatch(cheap, /Sale One/);
    const asc = await page('/catalog?sort=price_asc');
    assert.ok(asc.indexOf('Today One') < asc.indexOf('Plain One'));
  });

  test('заказ и корзина считают по цене со скидкой и запоминают её', async () => {
    const c = client(shop.base);
    await c.get('/');
    await c.post('/cart/add', { pid: ids.sale });
    const cart = nb((await c.get('/cart')).text);
    assert.match(cart, /12 790 ₽/);
    const co = (await c.get('/checkout')).text;
    const r = await c.post('/checkout', {
      idem: /name="idem" value="([^"]+)"/.exec(co)[1], name: 'Анна', phone: '89161234500', delivery: 'pickup',
      point: /name="point" value="(\d+)"/.exec(co)[1], pay: 'cod', consent: '1',
    });
    assert.equal(r.status, 303);
    const o = (await shop.db.query('SELECT o.total, i.price FROM webshop.orders o JOIN webshop.order_items i ON i.order_id = o.id ORDER BY o.id DESC LIMIT 1')).rows[0];
    assert.equal(Number(o.total), 12790);
    assert.equal(Number(o.price), 12790);
    // цену потом поменяли - заказ остаётся по цене на момент покупки
    await shop.db.query("UPDATE site_prices SET sale_price = 9990 WHERE model_key = 'SA-1'");
    const after = (await shop.db.query('SELECT total FROM webshop.orders ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(Number(after.total), 12790);
  });

  test('админка: цена сайта и цена склада различимы', async () => {
    const { c } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const html = nb((await c.get('/admin/showcase')).text);
    assert.match(html, /цена сайта/);
    assert.match(html, /цена склада/);
    assert.match(html, /9 990 ₽ \(было 15 990 ₽, −38%\)/, 'после правки цены в тесте выше скидка 9 990');
    assert.match(html, /Цены и скидки сайта \(вкладка «Цены сайта» в приложении\): задано для 6 моделей/);
  });
});

test('нет таблицы site_prices: сайт работает на ценах склада, в админке подсказка', async () => {
  const shop = await startShop('noprices', {}, { sitePrices: false });
  try {
    await addProduct(shop.db, { sku: 'NP-9_42', name: 'Кроссовки Nike No Prices', price: 7777, qty: 2 });
    const r = await client(shop.base).get('/p/np-9');
    assert.equal(r.status, 200);
    assert.match(r.text.replace(/ /g, ' '), /7 777 ₽/);
    assert.equal(shop.services.catalog.sitePricesState.status, 'missing');
    const { c } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    assert.match((await c.get('/admin/showcase')).text, /Цены сайта не подключены: в базе нет таблицы site_prices/);
  } finally { await shop.stop(); }
});
