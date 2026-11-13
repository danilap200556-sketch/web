'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addAdmin, adminLogin, jpeg } = require('./helpers');

// Минимальные «файлы» с правильными заголовками: сайт определяет тип по первым байтам
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 3)]);

test.describe('фон первого экрана: живой фон, своё фото и видео из админки', () => {
  let shop, admin;
  test.before(async () => {
    shop = await startShop('hero');
    for (let i = 1; i <= 4; i++) await addProduct(shop.db, { sku: `HR-${i}_42`, name: `Кроссовки Nike Hero ${i}`, price: 9000 + i * 100, qty: 3, vendor: 'Nike' });
    await addAdmin(shop.db, 'content1', 'editor');
    admin = await adminLogin(shop.base, 'content1', 'pass-12345');
  });
  test.after(async () => { await shop.stop(); });

  const upload = (buf, type, csrf = admin.csrf) => fetch(shop.base + '/admin/showcase/hero-media', {
    method: 'POST', redirect: 'manual', body: buf,
    headers: { 'content-type': type, 'x-csrf-token': csrf, accept: 'application/json', cookie: [...admin.c.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  });

  test('без своего файла: живой фон, витрина моделей, CSP разрешает видео со своего адреса', async () => {
    const r = await client(shop.base).get('/');
    assert.match(r.text, /hero hero--v3"/);
    assert.match(r.text, /data-hero-gl/);
    assert.doesNotMatch(r.text, /data-hero-video|hero__photo/);
    assert.match(r.text, /class="spot__item is-active"/);
    assert.match(r.headers.get('content-security-policy'), /media-src 'self'/);
  });

  test('загрузка без токена или с чужим файлом отклоняется', async () => {
    assert.equal((await upload(mp4(), 'video/mp4', 'wrong')).status, 403);
    const bad = await upload(Buffer.from('<html>это не видео</html>'.repeat(4)), 'video/mp4');
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /MP4, WebM/);
    const anon = await fetch(shop.base + '/admin/showcase/hero-media', { method: 'POST', body: mp4(), headers: { 'content-type': 'video/mp4' }, redirect: 'manual' });
    assert.equal(anon.status, 302, 'без входа - на страницу входа');
  });

  test('фото: сжимается в JPEG и стоит на первом экране вместо живого фона', async () => {
    const r = await upload(await jpeg('#336699'), 'image/jpeg');
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.kind, 'image');
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, new RegExp(`<img class="hero__photo" src="/media/hero/${d.id}"`));
    assert.doesNotMatch(home, /data-hero-gl/);
    const img = await fetch(`${shop.base}/media/hero/${d.id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /immutable/);
  });

  test('видео: заменяет фото, отдаётся кусками (Range), старый файл удаляется', async () => {
    const before = (await shop.db.query('SELECT id FROM webshop.hero_media')).rows.map((x) => x.id);
    const r = await upload(mp4(), 'video/mp4');
    assert.equal(r.status, 200);
    const { id, kind } = await r.json();
    assert.equal(kind, 'video');
    const left = (await shop.db.query('SELECT id FROM webshop.hero_media')).rows.map((x) => x.id);
    assert.deepEqual(left, [id], 'хранится только текущий фон');
    assert.ok(!before.includes(id));
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, new RegExp(`<video class="hero__video" muted loop playsinline preload="none" data-hero-video data-src="/media/hero/${id}">`));
    assert.match(home, /hero--media/);

    const full = await fetch(`${shop.base}/media/hero/${id}`);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const total = (await full.arrayBuffer()).byteLength;
    const part = await fetch(`${shop.base}/media/hero/${id}`, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-99/${total}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const tail = await fetch(`${shop.base}/media/hero/${id}`, { headers: { range: 'bytes=-10' } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes ${total - 10}-${total - 1}/${total}`);
    const past = await fetch(`${shop.base}/media/hero/${id}`, { headers: { range: `bytes=${total + 5}-` } });
    assert.equal(past.status, 416);
    assert.equal((await fetch(`${shop.base}/media/hero/${id + 1000}`)).status, 404);
    assert.equal((await fetch(`${shop.base}/media/hero/abc`)).status, 404);
  });

  test('WebM тоже принимается; «Убрать» возвращает живой фон', async () => {
    const r = await upload(webm(), 'video/webm');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).kind, 'video');
    const page = await admin.c.get('/admin/showcase');
    assert.match(page.text, /Фон первого экрана/);
    assert.match(page.text, /Сейчас на главной: <b>видео<\/b>/);
    const rm = await admin.c.post('/admin/showcase/hero-media/remove', { _csrf: admin.csrf });
    assert.equal(rm.status, 302);
    assert.equal((await shop.db.query('SELECT count(*)::int AS n FROM webshop.hero_media')).rows[0].n, 0);
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, /data-hero-gl/);
    assert.doesNotMatch(home, /data-hero-video/);
  });
});
