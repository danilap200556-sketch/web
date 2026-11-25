'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addAdmin, adminLogin, ymd } = require('./helpers');

test.describe('цены, акции и описания моделей из админки', () => {
  let shop, owner, editor, back;
  const model = async (key) => { shop.services.catalog.invalidate(); await shop.services.catalog.ensure(); return shop.services.catalog.allModels.find((m) => m.key === key); };
  const sp = async (key) => (await shop.db.query('SELECT model_key, price::float8 AS price, sale_price::float8 AS sale, to_char(sale_from, \'YYYY-MM-DD\') AS f, to_char(sale_to, \'YYYY-MM-DD\') AS t, updated_by FROM site_prices WHERE model_key = $1', [key])).rows[0];
  const post = (key, form) => owner.c.post('/admin/showcase/price', { _csrf: owner.csrf, key, back: '/admin/showcase', ...form });
  const flash = async () => (await owner.c.get('/admin/showcase')).text;

  test.before(async () => {
    shop = await startShop('scprices');
    await addProduct(shop.db, { sku: 'SP-1_42', name: 'Кроссовки Nike Price One', price: 10000, qty: 3, vendor: 'Nike' });
    await addProduct(shop.db, { sku: 'SP-2_42', name: 'Кроссовки adidas Price Two', price: 8000, qty: 2, vendor: 'adidas' });
    await addAdmin(shop.db, 'ed7', 'editor');
    owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    editor = await adminLogin(shop.base, 'ed7', 'pass-12345');
  });
  test.after(async () => { await shop.stop(); });

  test('в строке модели у владельца есть блок «Цена, акция и описание», у контент-менеджера нет', async () => {
    const o = (await owner.c.get('/admin/showcase?q=Price+One')).text;
    assert.match(o, /<summary>Цена, акция и описание<\/summary>/);
    assert.match(o, /action="\/admin\/showcase\/price"/);
    const e = (await editor.c.get('/admin/showcase?q=Price+One')).text;
    assert.doesNotMatch(e, /Цена, акция и описание/);
    const r = await editor.c.post('/admin/showcase/price', { _csrf: editor.csrf, key: 'SP-1', price: '1' });
    assert.equal(r.status, 403);
    assert.equal(await sp('SP-1'), undefined);
  });

  test('цена сайта: записывается в общую таблицу site_prices и сразу меняет цену на сайте', async () => {
    const r = await post('SP-1', { price: '15 000' });
    assert.equal(r.status, 302);
    const row = await sp('SP-1');
    assert.equal(row.price, 15000);
    assert.equal(row.sale, null);
    assert.match(row.updated_by, /^сайт: /);
    const m = await model('SP-1');
    assert.equal(m.price, 15000);
    assert.equal(m.priceSource, 'site');
    assert.match(await flash(), /Сохранено/);
    // поля строки показывают то, что задано
    assert.match((await owner.c.get('/admin/showcase?q=Price+One')).text, /name="price" value="15000"/);
  });

  test('акция: цена со скидкой действует в свои даты, до начала и после конца её нет', async () => {
    await post('SP-1', { price: '15000', sale: '12000', from: ymd(-1), to: ymd(5) });
    let m = await model('SP-1');
    assert.equal(m.price, 12000);
    assert.equal(m.oldPrice, 15000);
    assert.equal(m.discount, 20);
    const page = (await client(shop.base).get(`/p/${m.slug}`)).text;
    assert.match(page, /12\s000\s₽/);
    await post('SP-1', { price: '15000', sale: '12000', from: ymd(2), to: ymd(9) });
    m = await model('SP-1');
    assert.equal(m.price, 15000, 'акция ещё не началась');
    assert.equal(m.oldPrice, 0);
    await post('SP-1', { price: '15000', sale: '12000', from: ymd(-9), to: ymd(-2) });
    assert.equal((await model('SP-1')).oldPrice, 0, 'акция закончилась');
    assert.equal((await sp('SP-1')).t, ymd(-2));
  });

  test('ошибки: скидка не меньше цены, нет цены, отрицательное, плохие даты - ничего не меняется', async () => {
    await post('SP-1', { price: '15000' });
    const before = await sp('SP-1');
    const bad = [
      [{ price: '15000', sale: '16000' }, /меньше обычной/],
      [{ price: '', sale: '9000' }, /Укажите цену/],
      [{ price: '-5' }, /Цена: неверное число/],
      [{ price: '15000', sale: 'abc' }, /Цена со скидкой: неверное число/],
      [{ price: '15000', sale: '9000', from: '2026-13-40' }, /Даты скидки/],
      [{ price: '15000', sale: '9000', from: ymd(5), to: ymd(1) }, /Даты скидки/],
    ];
    for (const [form, re] of bad) {
      await post('SP-1', form);
      assert.match(await flash(), re, JSON.stringify(form));
      assert.deepEqual(await sp('SP-1'), before, `изменилось после ${JSON.stringify(form)}`);
    }
  });

  test('пустые цена и скидка возвращают цену склада; неизвестная модель и товары партнёра не принимаются', async () => {
    await post('SP-1', {});
    assert.equal(await sp('SP-1'), undefined);
    const m = await model('SP-1');
    assert.equal(m.price, 10000);
    assert.equal(m.priceSource, 'warehouse');
    await post('NOPE-9', { price: '100' });
    assert.match(await flash(), /Модель не найдена/);
    await post('ext:product/x', { price: '100' });
    assert.equal(await sp('ext:product/x'), undefined);
  });

  test('описание: своё вместо складского, остальные настройки модели не сбрасываются, пусто возвращает складское', async () => {
    await owner.c.post('/admin/showcase/model', { _csrf: owner.csrf, key: 'SP-2', badge: 'Хит', featured: 'on', back: '/admin/showcase' });
    await post('SP-2', { price: '8000', description: 'Лёгкие кроссовки на каждый день.\n\nПодошва из пены.' });
    let m = await model('SP-2');
    assert.match(m.description, /Лёгкие кроссовки на каждый день/);
    assert.equal(m.badge, 'Хит', 'ярлык сохранился');
    assert.equal(m.featured, true);
    const page = (await client(shop.base).get(`/p/${m.slug}`)).text;
    assert.match(page, /<p>Лёгкие кроссовки на каждый день\.<\/p>/);
    assert.match(page, /<p>Подошва из пены\.<\/p>/);
    assert.match((await owner.c.get('/admin/showcase?q=Price+Two')).text, /Лёгкие кроссовки на каждый день/, 'текст в форме для правки');
    await post('SP-2', { price: '8000', description: '' });
    m = await model('SP-2');
    assert.doesNotMatch(m.description, /Лёгкие/);
    assert.equal(m.badge, 'Хит');
  });

  test('нет таблицы site_prices: понятное сообщение вместо ошибки сервера', async () => {
    const off = await startShop('scprices_off', {}, { sitePrices: false });
    try {
      await addProduct(off.db, { sku: 'NP-1_42', name: 'Кроссовки Nike No Table', price: 5000, qty: 1, vendor: 'Nike' });
      const a = await adminLogin(off.base, 'owner1', 'owner-pass-123');
      const r = await a.c.post('/admin/showcase/price', { _csrf: a.csrf, key: 'NP-1', price: '6000', back: '/admin/showcase' });
      assert.equal(r.status, 302);
      assert.match((await a.c.get('/admin/showcase')).text, /таблицы site_prices нет/);
    } finally { await off.stop(); }
  });
});
