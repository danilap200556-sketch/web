'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startShop, client, addProduct } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test.describe('оформление v2: главная, корзина-панель, безопасность', () => {
  let shop, ids;
  test.before(async () => {
    shop = await startShop('design', { PUBLIC_URL: 'https://shop.test' });
    ids = [];
    for (let i = 1; i <= 6; i++) ids.push(await addProduct(shop.db, { sku: `DS-${i}_42`, name: `Кроссовки Nike Design ${i} «Test»`, price: 5000 + i * 1000, qty: i === 6 ? 1 : 5, vendor: 'Nike' }));
  });
  test.after(async () => { await shop.stop(); });

  test('страница подключает слой оформления, ранний boot.js и скрипт эффектов', async () => {
    const t = (await client(shop.base).get('/')).text;
    assert.match(t, /\/static\/css\/design\.css\?v=/);
    assert.match(t, /<script src="\/static\/js\/boot\.js\?v=[^"]+"><\/script>/, 'boot.js без defer: класс js ставится до отрисовки');
    assert.match(t, /\/static\/js\/fx\.js\?v=[^"]+" defer/);
    assert.match(t, /data-progress/);
    assert.match(t, /id="minicart"/);
    assert.match(t, /hero hero--v2/);
    assert.match(t, /class="marquee"/);
    assert.match(t, /data-rail/);
    assert.match(t, /data-rail-prev/);
    assert.match(t, /data-rail-next/);
    assert.match(t, /foot__word/);
    for (const f of ['css/design.css', 'js/fx.js', 'js/boot.js']) assert.equal((await client(shop.base).get('/static/' + f)).status, 200, f);
  });

  test('безопасная политика: ни одного inline-стиля и inline-скрипта (кроме разметки товара)', async () => {
    const c = client(shop.base);
    for (const p of ['/', '/catalog', '/cart']) {
      const t = (await c.get(p)).text;
      assert.doesNotMatch(t, /<[^>]+\sstyle="/i, `${p}: inline style`);
      assert.doesNotMatch(t, /<[^>]+\son(click|load|error)=/i, `${p}: inline-обработчики`);
      const inline = [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]).filter((s) => !/application\/ld\+json/.test(s));
      assert.deepEqual(inline, [], `${p}: inline-скрипты`);
    }
  });

  test('без JS содержимое не прячется: анимации появления включаются только под html.js', () => {
    const css = read('css/design.css').replace(/\/\*[\s\S]*?\*\//g, ''); // без комментариев
    for (const m of css.matchAll(/([^{}]*)\{[^}]*opacity:\s*0[^}]*\}/g)) {
      const sel = m[1].trim();
      if (/data-reveal/.test(sel)) assert.match(sel, /^\.js\s/, `правило с opacity:0 для «${sel}» должно начинаться с .js`);
    }
    assert.match(read('js/boot.js'), /classList\.add\('js'\)/);
  });

  test('карусели: у товаров есть карточки, электроника и пустые разделы не ломают главную', async () => {
    const t = (await client(shop.base).get('/')).text;
    assert.ok((t.match(/class="card/g) || []).length >= 6);
    assert.match(t, /Новинки/);
    assert.doesNotMatch(t, /class="promo"/, 'блока электроники нет, пока нет электроники');
  });

  test('API корзины: пусто, с товаром, суммы, прогресс до бесплатной доставки, нет в наличии', async () => {
    const c = client(shop.base);
    const empty = JSON.parse((await c.get('/api/cart', { headers: { accept: 'application/json' } })).text);
    assert.deepEqual({ count: empty.count, subtotal: empty.subtotal, lines: empty.lines.length }, { count: 0, subtotal: 0, lines: 0 });
    await c.get('/');
    await c.post('/cart/add', { pid: ids[0] }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    await c.post('/cart/add', { pid: ids[0] }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    await c.post('/cart/add', { pid: ids[1] }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    const r = await c.get('/api/cart', { headers: { accept: 'application/json' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const d = JSON.parse(r.text);
    assert.equal(d.count, 3);
    assert.equal(d.subtotal, 2 * 6000 + 7000);
    assert.equal(d.lines.length, 2);
    const l = d.lines.find((x) => x.pid === ids[0]);
    assert.equal(l.qty, 2); assert.equal(l.sum, 12000); assert.equal(l.max, 5);
    assert.match(l.title, /Design 1/);
    assert.equal(l.href.startsWith('/p/'), true);
    assert.match(l.meta, /Размер 42/);
    assert.match(l.img, /^\/media\/p\/\d+\/360\.jpg$/);
    assert.equal(l.out, false);
    assert.ok(d.free && d.free.threshold === 15000, 'порог бесплатной доставки из админки');
    assert.equal(d.free.left, 0);
    assert.equal(d.free.pct, 100);
    // изменение количества панелью и удаление
    const upd = JSON.parse((await c.post('/cart/update', { pid: ids[0], qty: 1 }, { headers: { accept: 'application/json', 'x-fetch': '1' } })).text);
    assert.equal(upd.ok, true);
    const d2 = JSON.parse((await c.get('/api/cart', { headers: { accept: 'application/json' } })).text);
    assert.equal(d2.count, 2);
    assert.equal(d2.free.left, 15000 - (6000 + 7000));
    await c.post('/cart/update', { pid: ids[0], qty: 0 }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    await c.post('/cart/update', { pid: ids[1], qty: 0 }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    assert.equal(JSON.parse((await c.get('/api/cart', { headers: { accept: 'application/json' } })).text).lines.length, 0);
    // товар закончился после добавления: строка помечена, сумма его не учитывает
    await c.post('/cart/add', { pid: ids[5] }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    await shop.db.query('UPDATE stock SET quantity = 0 WHERE product_id = $1', [ids[5]]);
    const gone = JSON.parse((await c.get('/api/cart', { headers: { accept: 'application/json' } })).text);
    assert.equal(gone.lines[0].out, true);
    assert.equal(gone.subtotal, 0);
    await shop.db.query('UPDATE stock SET quantity = 1 WHERE product_id = $1', [ids[5]]);
  });

  test('страница корзины: способы оплаты и рекомендации', async () => {
    const c = client(shop.base);
    await c.get('/');
    await c.post('/cart/add', { pid: ids[0] }, { headers: { accept: 'application/json', 'x-fetch': '1' } });
    const t = (await c.get('/cart')).text;
    assert.match(t, /class="paystrip"/);
    assert.match(t, />СБП</);
    assert.match(t, /При получении/);
    assert.match(t, /cartpage__recs/);
    assert.match(t, /С этим часто берут/);
    const e = client(shop.base);
    assert.match((await e.get('/cart')).text, /Что сейчас в тренде/, 'в пустой корзине подборка новинок');
  });
});
