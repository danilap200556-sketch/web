'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, adminLogin, addAdmin } = require('./helpers');
const { priceOf, markup } = require('../src/ext');

test('наценка: без дробной ошибки (100 000 ₽ + 10% = 110 000 ₽)', () => {
  assert.equal(markup(100000, 10), 110000);
  assert.equal(markup(99990, 10), 109990);
  assert.equal(markup(1000, 5), 1050);
  assert.equal(markup(30000, 7.5), 32250);
  assert.equal(markup(12345, 3.33), 12760);     // 12 755,9 вверх до 10 ₽
  assert.equal(markup(999, 0), 999);
});

test('цена электроники: ручная главнее всего, затем закупка с наценкой товара, затем общая наценка', () => {
  const row = (x) => ({ price: 100000, buy_price: null, markup_pct: null, manual_price: null, ...x });
  assert.equal(priceOf(row({}), 0), 100000);
  assert.equal(priceOf(row({}), 10), 110000);
  assert.equal(priceOf(row({ buy_price: 90000 }), 10), 99000, 'закупка вручную вместо цены партнёра');
  assert.equal(priceOf(row({ markup_pct: 5 }), 10), 105000, 'наценка товара вместо общей');
  assert.equal(priceOf(row({ markup_pct: 0 }), 10), 100000, 'наценка 0% - тоже значение');
  assert.equal(priceOf(row({ manual_price: 123457, buy_price: 1, markup_pct: 50 }), 10), 123457, 'ручная цена точная, без округления вверх');
  assert.equal(priceOf(row({ manual_price: 0 }), 10), 110000, 'ноль не считается ручной ценой');
  assert.equal(priceOf(row({ price: '99990.00', markup_pct: '10.00' }), 0), markup(99990, 10), 'числа из базы приходят строками');
});

test.describe('таблица цен на электронику в админке', () => {
  let shop, owner, editor, manager, ids;
  const slugOf = async (id) => (await shop.services.catalog.models.find((m) => m.ext && m.ext.id === id) || {}).slug;
  const siteModel = async (id) => { await shop.services.catalog.ensure(true).catch(() => {}); shop.services.catalog.invalidate(); await shop.services.catalog.ensure(); return shop.services.catalog.models.find((m) => m.ext && m.ext.id === id); };
  const row = async (id) => (await shop.db.query('SELECT * FROM webshop.ext_prices WHERE ext_id = $1', [id])).rows[0];
  const save = (form, extra = []) => owner.c.post('/admin/electronics/prices', [['_csrf', owner.csrf], ['ids', ids.join(',')], ...Object.entries(form), ...extra]);

  test.before(async () => {
    shop = await startShop('eprices', { PARTNER_SYNC: 'on', PARTNER_AUTOSTART: 'off' });
    const add = async (path, title, price, stock = true) => (await shop.db.query(
      "INSERT INTO webshop.ext_products (source, path, section, title, price, in_stock, images) VALUES ('sergeev', $1, 'tekhnika-apple', $2, $3, $4, '[\"https://x.test/a.jpg\"]'::jsonb) RETURNING id", [path, title, price, stock])).rows[0].id;
    ids = [await add('product/iphone-17', 'Смартфон Apple iPhone 17 256GB', 100000), await add('product/sony-xm6', 'Наушники Sony WH-1000XM6', 30000), await add('product/old', 'Кабель Type-C 1м', 990, false)];
    owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    await addAdmin(shop.db, 'ed9', 'editor'); await addAdmin(shop.db, 'mg9', 'manager');
    editor = await adminLogin(shop.base, 'ed9', 'pass-12345'); manager = await adminLogin(shop.base, 'mg9', 'pass-12345');
  });
  test.after(async () => { await shop.stop(); });

  test('страница: товары партнёра с закупкой, наценкой, ручной ценой и ценой на сайте; поиск и фильтры', async () => {
    const page = (await owner.c.get('/admin/electronics/prices')).text;
    for (const h of ['Закупка партнёра', 'Закупка вручную', 'Наценка, %', 'Ручная цена', 'Цена на сайте']) assert.ok(page.includes(h), h);
    assert.match(page, /Смартфон Apple iPhone 17 256GB/);
    assert.match(page, new RegExp(`name="man_${ids[0]}"`));
    assert.match(page, /100\s000\s₽/);
    assert.doesNotMatch((await owner.c.get('/admin/electronics/prices?q=sony')).text, /iPhone 17/);
    assert.match((await owner.c.get('/admin/electronics/prices?q=sony')).text, /Sony WH-1000XM6/);
    assert.doesNotMatch((await owner.c.get('/admin/electronics/prices?flt=out')).text, /iPhone 17/, 'фильтр «нет в наличии»');
    assert.match((await owner.c.get('/admin/electronics/prices?flt=out')).text, /Кабель Type-C/);
  });

  test('ручная цена меняет цену на витрине, пустое поле возвращает цену партнёра', async () => {
    const r = await save({ [`man_${ids[0]}`]: '123 457' });
    assert.equal(r.status, 302);
    assert.equal(Number((await row(ids[0])).manual_price), 123457);
    assert.equal((await siteModel(ids[0])).price, 123457);
    const html = (await client(shop.base).get(`/p/${(await siteModel(ids[0])).slug}`)).text;
    assert.match(html, /123\s457\s₽/);
    await save({ [`man_${ids[0]}`]: '' });
    assert.equal(await row(ids[0]), undefined, 'строка без переопределений удаляется');
    assert.equal((await siteModel(ids[0])).price, 100000);
  });

  test('наценка товара и закупка вручную считаются на сервере', async () => {
    await save({ [`mk_${ids[1]}`]: '7,5' });
    assert.equal((await siteModel(ids[1])).price, markup(30000, 7.5));
    await save({ [`mk_${ids[1]}`]: '', [`buy_${ids[1]}`]: '28000' });
    await shop.services.settings.set({ electronics: { markupPct: 10, showOldPrice: false } });
    try { assert.equal((await siteModel(ids[1])).price, markup(28000, 10), 'закупка вручную плюс общая наценка'); } finally { await shop.services.settings.set({ electronics: { markupPct: 0, showOldPrice: false } }); }
    await save({ [`buy_${ids[1]}`]: '' });
  });

  test('ошибки в значениях: ничего не сохраняется, введённое остаётся в форме', async () => {
    await save({ [`man_${ids[0]}`]: '150000' });
    const bad = await save({ [`man_${ids[0]}`]: '99999', [`mk_${ids[1]}`]: '400', [`buy_${ids[2]}`]: 'abc' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /Наценка: число от 0 до 300/);
    assert.match(bad.text, /Закупка: неверное число/);
    assert.ok(bad.text.includes('value="99999"'), 'введённое осталось');
    assert.equal(Number((await row(ids[0])).manual_price), 150000, 'старое значение не тронуто');
    assert.equal(await row(ids[1]), undefined);
    await save({ [`man_${ids[0]}`]: '' });
  });

  test('выгрузка в таблицу (CSV для Excel) и загрузка обратно', async () => {
    await save({ [`man_${ids[0]}`]: '111111' });
    const csv = await owner.c.get('/admin/electronics/prices.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="/);
    assert.ok(csv.text.startsWith('id;Название;Бренд;Закупка партнёра;Закупка вручную;Наценка, %;Ручная цена;Цена на сайте;В наличии'));
    const raw = new Uint8Array(await (await fetch(`${shop.base}/admin/electronics/prices.csv`, { headers: { cookie: [...owner.c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).arrayBuffer());
    assert.deepEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM в начале: Excel открывает кириллицу без «кракозябр»');
    assert.ok(csv.text.includes(`${ids[0]};Смартфон Apple iPhone 17 256GB;Apple;100000;;;111111;111111;да`));
    // загрузка: правим ручную цену и наценку, неизвестный номер и мусор попадают в отчёт, верные строки применяются
    const data = ['id;Ручная цена;Наценка, %', `${ids[0]};;`, `${ids[1]};35000;`, `${ids[2]};;12,5`, '999999;1;', `${ids[0] + 0.5};5;`, `${ids[1]};abc;`].join('\n');
    const r = await owner.c.post('/admin/electronics/prices/import', { _csrf: owner.csrf, data });
    assert.equal(r.status, 302);
    const flash = (await owner.c.get('/admin/electronics/prices')).text;
    assert.match(flash, /Обновлено товаров: 3/);
    assert.match(flash, /строка 5: товара с номером 999999 нет/);
    assert.match(flash, /строка 7: неверное число/);
    assert.equal(await row(ids[0]), undefined);
    assert.equal(Number((await row(ids[1])).manual_price), 35000);
    assert.equal(Number((await row(ids[2])).markup_pct), 12.5);
    // Excel отдаёт вставку табуляцией; строка без колонки id - ошибка
    const tab = await owner.c.post('/admin/electronics/prices/import', { _csrf: owner.csrf, data: `id\tРучная цена\n${ids[0]}\t101010` });
    assert.equal(tab.status, 302);
    assert.equal(Number((await row(ids[0])).manual_price), 101010);
    await owner.c.post('/admin/electronics/prices/import', { _csrf: owner.csrf, data: 'Название;Ручная цена\nX;1' });
    assert.match((await owner.c.get('/admin/electronics/prices')).text, /Нужна колонка id/);
    await owner.c.post('/admin/electronics/prices/import', { _csrf: owner.csrf, data: `id;Ручная цена\n${ids[0]};\n${ids[1]};\n${ids[2]};` });
    assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.ext_prices')).rows[0].n, 1, 'осталась только наценка у третьего товара');
  });

  test('доступ только владельцу; без токена CSRF отклоняется', async () => {
    for (const who of [editor, manager]) {
      assert.equal((await who.c.get('/admin/electronics/prices')).status, 403);
      assert.equal((await who.c.get('/admin/electronics/prices.csv')).status, 403);
      assert.equal((await who.c.post('/admin/electronics/prices', [['_csrf', who.csrf], ['ids', String(ids[0])], [`man_${ids[0]}`, '1']])).status, 403);
    }
    const r = await owner.c.post('/admin/electronics/prices', [['ids', String(ids[0])], [`man_${ids[0]}`, '1']]);
    assert.equal(r.status, 403);
    assert.match(r.text, /Страница устарела/);
  });
});
