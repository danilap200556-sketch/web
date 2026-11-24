'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { startShop, client, addProduct, addAdmin, adminLogin } = require('./helpers');
const { sellerName, telegramUrl } = require('../src/shopviews');

// Одноцветный логотип на ровном чёрном фоне: белый квадрат посередине
const blackLogo = () => sharp({ create: { width: 400, height: 300, channels: 3, background: '#0b0b0b' } })
  .composite([{ input: { create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }, left: 100, top: 100 }]).png().toBuffer();

test.describe('логотип из админки, юридические данные в подвале', () => {
  let shop, editor, owner;
  test.before(async () => {
    shop = await startShop('logo');
    await addProduct(shop.db, { sku: 'LG-1_42', name: 'Кроссовки Nike Logo 1', price: 9000, qty: 2, vendor: 'Nike' });
    await addAdmin(shop.db, 'content2', 'editor');
    editor = await adminLogin(shop.base, 'content2', 'pass-12345');
    owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  });
  test.after(async () => { await shop.stop(); });

  const upload = (buf, query = '', csrf = editor.csrf) => fetch(shop.base + '/admin/showcase/logo' + query, {
    method: 'POST', redirect: 'manual', body: buf,
    headers: { 'content-type': 'image/png', 'x-csrf-token': csrf, accept: 'application/json', cookie: [...editor.c.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });

  test('без своего файла - логотип по умолчанию в шапке, подвале и значке вкладки', async () => {
    const t = (await client(shop.base).get('/')).text;
    assert.match(t, /<img class="logo__img " src="\/static\/img\/logo-ks-light\.svg"/);
    assert.match(t, /src="\/static\/img\/logo-ks-dark\.svg"/, 'в белом меню на телефоне - тёмный вариант');
    assert.match(t, /<link rel="icon" href="\/static\/favicon\.svg"/);
    for (const f of ['img/logo-ks-light.svg', 'img/logo-ks-dark.svg', 'img/spark.svg', 'img/streak.svg', 'fonts/unbounded-cyrillic-wght-normal.woff2']) {
      assert.equal((await client(shop.base).get('/static/' + f)).status, 200, f);
    }
  });

  test('загрузка: без токена и не картинка - отказ; одноцветный - фон убран, знаки перекрашены', async () => {
    assert.equal((await upload(await blackLogo(), '', 'wrong')).status, 403);
    const bad = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.repeat(3)));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /PNG, JPEG или WebP/);

    const r = await upload(await blackLogo(), '?mono=1');
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, new RegExp(`src="/media/logo/${id}/light\\.png"`));
    assert.match(home, new RegExp(`<link rel="icon" href="/media/logo/${id}/icon\\.png" type="image/png">`));
    assert.match(home, /alt="[^"]+" width="96" height="48"/, 'размеры по пропорциям логотипа (обрезан по знаку 2:1)');

    const res = await fetch(`${shop.base}/media/logo/${id}/dark.png`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /immutable/);
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.equal(info.width / info.height, 2, 'пустой фон обрезан');
    const mid = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
    assert.ok(data[mid] < 30 && data[mid + 3] > 240, 'знак тёмный и непрозрачный');
    const light = await sharp(Buffer.from(await (await fetch(`${shop.base}/media/logo/${id}/light.png`)).arrayBuffer())).raw().toBuffer();
    assert.ok(light[mid] > 225, 'светлый вариант белый');
    assert.equal((await fetch(`${shop.base}/media/logo/${id}/secret.png`)).status, 404);
    assert.equal((await fetch(`${shop.base}/media/logo/${id + 50}/dark.png`)).status, 404);
    const fav = await fetch(shop.base + '/favicon.ico', { redirect: 'manual' });
    assert.equal(fav.headers.get('location'), `/media/logo/${id}/icon.png`);

    const page = await editor.c.get('/admin/showcase');
    assert.match(page.text, /Сейчас: <b>свой логотип<\/b>, одноцветный/);
  });

  test('название рядом с логотипом и «Убрать» возвращают как было', async () => {
    await editor.c.post('/admin/showcase/logo-text', { _csrf: editor.csrf, logoText: 'on' });
    assert.match((await client(shop.base).get('/')).text, /<span class="logo__text">/);
    const rm = await editor.c.post('/admin/showcase/logo/remove', { _csrf: editor.csrf });
    assert.equal(rm.status, 302);
    assert.equal((await shop.db.query('SELECT count(*)::int AS n FROM webshop.site_logo')).rows[0].n, 0);
    assert.match((await client(shop.base).get('/')).text, /logo-ks-light\.svg/);
  });

  test('юридическая плашка: продавец из реквизитов, ИНН, ОГРНИП; неверный ОГРНИП не сохраняется', async () => {
    let t = (await client(shop.base).get('/')).text;
    assert.match(t, /class="legal"/);
    assert.match(t, /<dt>Продавец<\/dt><dd>ИП Усатов Егор Николаевич<\/dd>/);
    assert.match(t, /<dt>ИНН<\/dt><dd>616614137900<\/dd>/);
    assert.doesNotMatch(t, /ОГРНИП/, 'пока не указан - строки нет');

    const base = { _csrf: owner.csrf, shopName: 'KS Store', phone: '+7 900 000-00-00', email: 'shop@example.ru', hours: '10-20', address: 'Москва' };
    await owner.c.post('/admin/settings', { ...base, ogrnip: '12345' });
    assert.doesNotMatch((await client(shop.base).get('/')).text, /ОГРНИП/);
    await owner.c.post('/admin/settings', { ...base, telegram: 'не ссылка!', ogrnip: '322508100353184' });
    assert.doesNotMatch((await client(shop.base).get('/')).text, /322508100353184/, 'ошибка в Telegram - ничего не сохранилось');

    const ok = await owner.c.post('/admin/settings', { ...base, telegram: '@ks_store', ogrnip: '322508100353184', legalAddress: 'г. Москва, ул. Юридическая, 2', about: 'KS Store - оригинальные кроссовки' });
    assert.equal(ok.status, 302);
    t = (await client(shop.base).get('/')).text;
    assert.match(t, /<dt>ОГРНИП<\/dt><dd>322508100353184<\/dd>/);
    assert.match(t, /<dt>Юридический адрес<\/dt><dd>г\. Москва, ул\. Юридическая, 2<\/dd>/);
    assert.match(t, /KS Store - оригинальные кроссовки/);
    assert.match(t, /href="https:\/\/t\.me\/ks_store"/, 'Telegram из настроек в шапке и подвале');
    const page = await owner.c.get('/admin/settings');
    assert.match(page.text, /value="322508100353184"/);
  });

  test('продавец и Telegram: разбор значений', () => {
    assert.equal(sellerName('ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ ИВАНОВ-ПЕТРОВ ИВАН'), 'ИП Иванов-Петров Иван');
    assert.equal(sellerName('ООО «Ромашка»'), 'ООО «Ромашка»');
    assert.equal(telegramUrl('@shop_1'), 'https://t.me/shop_1');
    assert.equal(telegramUrl('t.me/shop_1'), 'https://t.me/shop_1');
    assert.equal(telegramUrl('javascript:alert(1)'), '');
  });
});
