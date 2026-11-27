'use strict';
// Кэш готовых фото на диске: файлы переживают перезапуск сайта, размер ограничен, без папки всё работает как раньше.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createDiskCache } = require('../src/mediacache');
const { startShop, client, addProduct } = require('./helpers');
const { fakeBaza } = require('./fake-baza');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcache-'));
const quiet = { warn() {} };

test('запись и чтение; плохие имена не принимаются; пустое не пишется', async () => {
  const dir = tmp();
  const c = createDiskCache({ dir, log: quiet });
  assert.equal(c.enabled(), true);
  assert.equal(await c.get('p1_360.jpg'), null, 'ничего нет');
  assert.equal(await c.set('p1_360.jpg', Buffer.from('фото')), true);
  assert.equal((await c.get('p1_360.jpg')).toString(), 'фото');
  for (const bad of ['../x', 'a/b', '', 'a b', 'x'.repeat(200), '..']) {
    assert.equal(await c.set(bad, Buffer.from('1')), false, `имя «${bad.slice(0, 20)}» отклонено`);
    assert.equal(await c.get(bad), null);
  }
  assert.equal(await c.set('empty.jpg', Buffer.alloc(0)), false);
  assert.deepEqual(fs.readdirSync(dir), ['p1_360.jpg'], 'временных файлов не осталось');
});

test('файл виден только целиком: параллельные записи одного имени не портят друг друга', async () => {
  const dir = tmp();
  const c = createDiskCache({ dir, log: quiet });
  const a = Buffer.alloc(300_000, 1);
  const b = Buffer.alloc(300_000, 2);
  await Promise.all([c.set('same.jpg', a), c.set('same.jpg', b), c.set('same.jpg', a)]);
  const got = await c.get('same.jpg');
  assert.equal(got.length, 300_000);
  assert.ok(got.every((x) => x === got[0]), 'целый файл, без примеси чужих данных');
  assert.deepEqual(fs.readdirSync(dir), ['same.jpg']);
});

test('без папки или без прав: кэш выключен, ничего не падает', async () => {
  const off = createDiskCache({ dir: '', log: quiet });
  assert.equal(off.enabled(), false);
  assert.equal(await off.set('a.jpg', Buffer.from('x')), false);
  assert.equal(await off.get('a.jpg'), null);
  const file = path.join(tmp(), 'file');
  fs.writeFileSync(file, 'не папка');
  const bad = createDiskCache({ dir: path.join(file, 'sub'), log: quiet });   // папку создать нельзя: путь идёт через обычный файл
  assert.equal(bad.enabled(), false);
  assert.deepEqual(await bad.prune(), { removed: 0, bytes: 0 });
});

test('очистка: лишнее удаляется, начиная с давно не использованного; свежее и нужное остаётся', async () => {
  const dir = tmp();
  const c = createDiskCache({ dir, maxBytes: 1000, log: quiet });
  const put = async (name, age) => { await c.set(name, Buffer.alloc(300, 7)); const t = new Date(Date.now() - age * 1000); fs.utimesSync(path.join(dir, name), t, t); };
  await put('old.jpg', 500); await put('mid.jpg', 300); await put('new.jpg', 100); await put('newest.jpg', 10);      // 1200 байт при лимите 1000
  const r = await c.prune();
  assert.equal(r.removed, 2, 'до 80% лимита (800 байт) убраны два самых давних');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['new.jpg', 'newest.jpg']);
  assert.equal((await c.prune()).removed, 0, 'в пределах лимита ничего не трогаем');
  // брошенный недописанный файл старше часа удаляется, свежий - нет
  fs.writeFileSync(path.join(dir, 'a.jpg.1.aa.tmp'), 'x');
  fs.writeFileSync(path.join(dir, 'b.jpg.1.bb.tmp'), 'x');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(path.join(dir, 'a.jpg.1.aa.tmp'), old, old);
  await c.prune();
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), ['b.jpg.1.bb.tmp']);
});

test('чтение отмечает файл «использованным»: нужное не удаляется первым', async () => {
  const dir = tmp();
  const c = createDiskCache({ dir, maxBytes: 700, log: quiet });
  await c.set('a.jpg', Buffer.alloc(300)); await c.set('b.jpg', Buffer.alloc(300)); await c.set('c.jpg', Buffer.alloc(300));
  const t = (s) => new Date(Date.now() - s * 1000);
  for (const [n, s] of [['a.jpg', 300], ['b.jpg', 200], ['c.jpg', 100]]) fs.utimesSync(path.join(dir, n), t(s), t(s));
  await c.get('a.jpg');                                  // самый старый использовали только что
  await new Promise((r) => setTimeout(r, 50));
  await c.prune();
  assert.ok(fs.existsSync(path.join(dir, 'a.jpg')), 'a.jpg использован недавно - остался');
  assert.ok(!fs.existsSync(path.join(dir, 'b.jpg')), 'b.jpg теперь самый давний - удалён');
});

test.describe('фото в магазине: после «перезапуска» берутся с диска', () => {
  let shop, dir, fb, pid;
  test.before(async () => {
    dir = tmp();
    fb = await fakeBaza();
    shop = await startShop('mcache', { PARTNER_SYNC: 'off', BAZA_SYNC: 'on', BAZA_AUTOSTART: 'off', BAZA_URL: fb.url, BAZA_DELAY_MS: '0', MEDIA_CACHE_DIR: dir }, { app: { sleep: async () => {} } });
    pid = await addProduct(shop.db, { sku: 'MC-1_42', name: 'Кроссовки Nike Disk One', price: 9000, qty: 2 });
  });
  test.after(async () => { await shop.stop(); await fb.close(); });
  const files = () => fs.readdirSync(dir).filter((x) => !x.endsWith('.tmp'));
  const settle = async (n) => { for (let i = 0; i < 100 && files().length < n; i++) await new Promise((r) => setTimeout(r, 30)); };

  test('фото склада: готовый файл ложится на диск и отдаётся оттуда, когда память пуста, а в базе фото уже нет', async () => {
    const photoId = (await shop.db.query('SELECT id FROM product_photos WHERE product_id = $1', [pid])).rows[0].id;
    const url = `${shop.base}/media/p/${photoId}/360.jpg`;
    const a = await fetch(url, { headers: { accept: 'image/webp' } });
    assert.equal(a.status, 200);
    const first = Buffer.from(await a.arrayBuffer());
    await settle(1);
    assert.deepEqual(files().filter((x) => x.startsWith(`p${photoId}_360_w_`)).length, 1, 'файл с размером, форматом и версией в имени');
    shop.services.media.dropMemory();
    await shop.db.query('DELETE FROM product_photos WHERE id = $1', [photoId]);      // источника нет: ответ может прийти только с диска
    const b = await fetch(url, { headers: { accept: 'image/webp' } });
    assert.equal(b.status, 200);
    assert.deepEqual(Buffer.from(await b.arrayBuffer()), first, 'тот же файл');
    assert.match(b.headers.get('content-type'), /image\/webp/);
    // другой формат/размер - другой файл, его на диске нет, а источника нет: 404 (а не чужой формат)
    assert.equal((await fetch(`${shop.base}/media/p/${photoId}/640.jpg`)).status, 404);
  });

  test('фото партнёра: оригинал скачивается один раз на все размеры; после «перезапуска» сайт партнёра не нужен', async () => {
    const partner = shop.services.partner;
    await partner.get('baza').syncListings();
    await partner.get('baza').syncDetails({ limit: 20 });
    shop.services.catalog.invalidate(); await shop.services.catalog.ensure();
    const m = shop.services.catalog.models.find((x) => x.ext && x.ext.path.includes('iphone-18-pro'));
    const n = m.ext.id * 10;
    const hits0 = fb.st.hits.filter((h) => h.startsWith('/upload/')).length;
    for (const w of [360, 640]) assert.equal((await fetch(`${shop.base}/media/x/${n}/${w}.jpg`)).status, 200);
    const downloads = fb.st.hits.filter((h) => h.startsWith('/upload/')).length - hits0;
    assert.equal(downloads, 1, 'два размера - одно скачивание оригинала');
    await settle(4);
    assert.ok(files().some((x) => x.startsWith('o_')), 'оригинал сохранён');
    assert.equal(files().filter((x) => x.startsWith(`x${m.ext.id}_0_`)).length, 2, 'готовые 360 и 640');
    // «перезапуск»: память пуста, сайт партнёра недоступен
    shop.services.media.dropMemory();
    await fb.close();
    const again = await fetch(`${shop.base}/media/x/${n}/360.jpg`);
    assert.equal(again.status, 200, 'с диска, без обращения к партнёру');
    const meta = await sharp(Buffer.from(await again.arrayBuffer())).metadata();
    assert.equal(`${meta.width}x${meta.height}`, '360x360');
    // новый размер: готового файла нет, но оригинал на диске - партнёр всё равно не нужен
    assert.equal((await fetch(`${shop.base}/media/x/${n}/1280.jpg`)).status, 200);
    fb = await fakeBaza();       // для остановки в after
  });

  test('без MEDIA_CACHE_DIR на диск ничего не пишется, фото работают как раньше', async () => {
    const s2 = await startShop('mcache2', { PARTNER_SYNC: 'off' });
    try {
      const p2 = await addProduct(s2.db, { sku: 'MC-2_42', name: 'Кроссовки Nike Disk Two', price: 9000, qty: 2 });
      const id = (await s2.db.query('SELECT id FROM product_photos WHERE product_id = $1', [p2])).rows[0].id;
      assert.equal((await client(s2.base).get(`/media/p/${id}/360.jpg`)).status, 200);
      assert.equal(s2.services.media ? true : false, true);
      assert.equal(s2.cfg.mediaCache.dir, '');
    } finally { await s2.stop(); }
  });
});
