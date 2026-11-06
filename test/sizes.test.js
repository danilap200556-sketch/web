'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, adminLogin } = require('./helpers');

test.describe('размеры на сайте: только цифры и буквы', () => {
  let shop;
  test.before(async () => {
    shop = await startShop('sizes');
    const name = 'Кроссовки Nike Sizes «Test»';
    for (const [sku, qty] of [['SZ-1_41', 2], ['SZ-1_42', 1], ['SZ-1_42(б/к)', 4], ['SZ-1_43 (1 кроссовок)', 1], ['SZ-1_44(D)', 2], ['SZ-1_45(Брак)', 1]]) await addProduct(shop.db, { sku, name, price: 9990, qty });
    await addProduct(shop.db, { sku: 'SZ-2_40(б/к)', name: 'Кроссовки Nike OnlyNoted «Test»', price: 9990, qty: 1 }); // только вариант без коробки
    await addProduct(shop.db, { sku: 'SZ-3_L/XL', name: 'Худи Nike Double «Test»', price: 5990, qty: 2 });
  });
  test.after(async () => { await shop.stop(); });

  const sizesOf = (html) => [...html.matchAll(/data-size-label="([^"]*)"/g)].map((m) => m[1]);

  test('карточка товара: подписи размеров без слов, варианты с пометками не продаются', async () => {
    const c = client(shop.base);
    const pdp = (await c.get('/p/sz-1')).text;
    assert.deepEqual(sizesOf(pdp), ['41', '42', '44']);
    assert.doesNotMatch(pdp, /без коробки|один кроссовок|Брак|·\s*D/);
    assert.match(pdp, /<span>44<\/span>/, 'ширина D обычная: размер 44 есть');
    assert.equal((await c.get('/p/sz-2')).status, 404, 'модель, где только вариант без коробки, не показывается');
    assert.match((await c.get('/p/sz-3')).text, /data-size-label="L\/XL"/, 'двойной размер одежды показывается целиком');
  });

  test('каталог и фильтр размеров: только обычные размеры', async () => {
    const c = client(shop.base);
    const cat = (await c.get('/catalog')).text;
    assert.doesNotMatch(cat, /без коробки|один кроссовок|Брак/);
    assert.match(cat, /41 · 42 · 44|41–44/);
    assert.equal((await c.get('/catalog?size=43')).text.includes('Sizes'), false, 'размера 43 (один кроссовок) на сайте нет');
    assert.match((await c.get('/catalog?size=44')).text, /Sizes/);
  });

  test('в корзину кладётся обычный вариант, подпись в корзине и заказе - просто размер', async () => {
    const c = client(shop.base);
    await c.get('/');
    const pdp = (await c.get('/p/sz-1')).text;
    const pid42 = /name="pid" value="(\d+)"[^>]*data-size-label="42"/.exec(pdp)[1];
    const row = (await shop.db.query('SELECT sku FROM products WHERE id = $1', [pid42])).rows[0];
    assert.equal(row.sku, 'SZ-1_42', 'под размером 42 продаётся пара без пометки, а не «без коробки»');
    await c.post('/cart/add', { pid: pid42 });
    const cart = (await c.get('/cart')).text;
    assert.match(cart, /Размер: <b>42<\/b>/);
    assert.doesNotMatch(cart, /без коробки/);
  });

  test('админка: в «Витрине» видна причина и можно включить продажу вариантов с пометками, подписи по-прежнему без слов', async () => {
    const a = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    const page = (await a.c.get('/admin/showcase?show=hidden')).text;
    assert.match(page, /Только размеры с пометками/, 'причина скрытия объяснена');
    assert.match((await a.c.get('/admin/showcase')).text, /name="showNoteSizes"/);
    const r = await a.c.post('/admin/showcase/season', { _csrf: a.csrf, mode: 'auto', requirePhoto: 'on', showNoteSizes: 'on' });
    assert.equal(r.status, 302);
    const c = client(shop.base);
    assert.deepEqual(sizesOf((await c.get('/p/sz-1')).text), ['41', '42', '43', '44', '45']);
    assert.doesNotMatch((await c.get('/p/sz-1')).text, /без коробки|один кроссовок|Брак/, 'и с включённой настройкой слов нет');
    assert.equal((await c.get('/p/sz-2')).status, 200, 'модель с вариантом без коробки появилась');
    assert.deepEqual(sizesOf((await c.get('/p/sz-2')).text), ['40']);
    await a.c.post('/admin/showcase/season', { _csrf: a.csrf, mode: 'auto', requirePhoto: 'on' });
    assert.equal((await client(shop.base).get('/p/sz-2')).status, 404, 'выключили - снова скрыта');
  });
});
