'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { studio } = require('../src/photofix');
const { startShop, client, addProduct } = require('./helpers');

const solid = (w, h, color) => ({ create: { width: w, height: h, channels: 3, background: color } });
const png = (w, h, bg, parts = []) => sharp(solid(w, h, bg)).composite(parts.map((p) => ({ input: solid(p.w, p.h, p.color), left: p.x, top: p.y }))).png().toBuffer();
async function pixels(buf) { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height, at: (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)] }; }
// Рамка всего, что заметно темнее фона
function darkBox(p, limit = 120) {
  let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) { const i = (y * p.w + x) * 3; if (p.data[i] < limit && p.data[i + 1] < limit && p.data[i + 2] < limit) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return { x0, y0, x1, y1 };
}

test('светлый фон и товар сбоку: на выходе квадрат, фон белый, товар по центру с ровными полями', async () => {
  const input = await png(600, 400, '#f2f2f2', [{ x: 400, y: 250, w: 100, h: 60, color: '#111111' }]);
  const out = await studio(input, 400);
  assert.equal(out.type, 'image/jpeg');
  const p = await pixels(out.buf);
  assert.deepEqual([p.w, p.h], [400, 400]);
  for (const [x, y] of [[2, 2], [397, 2], [2, 397], [397, 397], [200, 8]]) assert.ok(p.at(x, y).every((v) => v >= 252), `фон не белый в ${x},${y}: ${p.at(x, y)}`);
  const b = darkBox(p);
  assert.ok(Math.abs(b.x0 - (399 - b.x1)) <= 4, `по горизонтали не по центру: ${JSON.stringify(b)}`);
  assert.ok(Math.abs(b.y0 - (399 - b.y1)) <= 4, `по вертикали не по центру: ${JSON.stringify(b)}`);
  assert.ok(b.x0 >= 20 && b.x0 <= 44, `поле слева ${b.x0}px: около 7%`);
  assert.ok(b.x1 - b.x0 >= 330, 'товар занимает почти всю ширину полезной области');
});

test('одинаковый товар на белом и на сером фоне даёт одинаковый кадр', async () => {
  const parts = [{ x: 150, y: 120, w: 200, h: 100, color: '#222222' }];
  const a = await pixels((await studio(await png(500, 340, '#ffffff', parts), 300)).buf);
  const b = await pixels((await studio(await png(500, 340, '#ededed', parts), 300)).buf);
  const ba = darkBox(a);
  const bb = darkBox(b);
  for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(Math.abs(ba[k] - bb[k]) <= 2, `${k}: ${ba[k]} и ${bb[k]}`);
});

test('слабая тень внутри кадра становится белой, тёмная часть товара остаётся', async () => {
  // Маленькая тёмная метка вдали растягивает рамку так, что светлая «тень» остаётся внутри кадра
  const input = await png(600, 600, '#f4f4f4', [{ x: 150, y: 150, w: 300, h: 260, color: '#1a1a1a' }, { x: 150, y: 420, w: 330, h: 40, color: '#e9e9e9' }, { x: 500, y: 500, w: 5, h: 5, color: '#222222' }]);
  const p = await pixels((await studio(input, 300)).buf);
  const shadow = p.at(130, 232);            // где лежала светлая полоса
  assert.ok(shadow.every((v) => v >= 250), `тень осталась: ${shadow}`);
  assert.ok(p.at(130, 116).every((v) => v < 60), 'товар остался тёмным');
});

test('пёстрый фон не обрезаем и не выбеливаем: квадрат, цвет фона сохранён', async () => {
  const w = 500; const h = 300;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; buf[i] = Math.round((x / w) * 255); buf[i + 1] = 40; buf[i + 2] = Math.round((1 - x / w) * 255); }
  const input = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const p = await pixels((await studio(input, 320)).buf);
  assert.deepEqual([p.w, p.h], [320, 320]);
  const mid = p.at(160, 160);
  assert.ok(mid[1] < 90 && !mid.every((v) => v > 240), `середина кадра изменена: ${mid}`);
  assert.deepEqual(p.at(160, 2), [255, 255, 255], 'поля сверху и снизу белые');
});

test('прозрачный PNG кладётся на белое, пустое и битое не роняют', async () => {
  const transparent = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: solid(80, 50, '#333333'), left: 100, top: 70 }]).png().toBuffer();
  const p = await pixels((await studio(transparent, 200)).buf);
  assert.ok(p.at(3, 3).every((v) => v >= 252));
  const blank = await pixels((await studio(await png(300, 200, '#f6f6f6'), 200)).buf);
  assert.deepEqual([blank.w, blank.h], [200, 200]);
  await assert.rejects(studio(Buffer.from('это не картинка'), 200));
});

test('webp по запросу', async () => {
  const out = await studio(await png(200, 200, '#f5f5f5', [{ x: 50, y: 50, w: 100, h: 100, color: '#000000' }]), 160, true);
  assert.equal(out.type, 'image/webp');
  assert.equal((await sharp(out.buf).metadata()).format, 'webp');
});

test.describe('фото в магазине отдаются в едином виде', () => {
  let shop, pid;
  test.before(async () => {
    shop = await startShop('photofix');
    pid = await addProduct(shop.db, { sku: 'PF-1_42', name: 'Кроссовки Nike Photo Fix', price: 9000, qty: 2, photo: false });
    const jpeg = await sharp(solid(640, 420, '#f0f0f0')).composite([{ input: solid(300, 120, '#202020'), left: 280, top: 200 }]).jpeg({ quality: 92 }).toBuffer();
    await shop.db.query('INSERT INTO product_photos (product_id, position, data, thumb) VALUES ($1, 1, $2, $2)', [pid, jpeg]);
  });
  test.after(async () => { await shop.stop(); });

  test('фото склада: квадрат, белый фон, товар по центру', async () => {
    const id = (await shop.db.query('SELECT id FROM product_photos WHERE product_id = $1', [pid])).rows[0].id;
    const r = await client(shop.base).get(`/media/p/${id}/360.jpg`);
    assert.equal(r.status, 200);
    const res = await fetch(`${shop.base}/media/p/${id}/360.jpg`);
    const p = await pixels(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual([p.w, p.h], [360, 360]);
    assert.ok(p.at(4, 4).every((v) => v >= 250));
    const b = darkBox(p);
    assert.ok(Math.abs(b.x0 - (359 - b.x1)) <= 5 && Math.abs(b.y0 - (359 - b.y1)) <= 5, JSON.stringify(b));
  });

  test('адрес фото несёт версию, чтобы браузеры не держали старое', async () => {
    const page = (await client(shop.base).get('/catalog')).text;
    assert.match(page, /\/media\/p\/\d+\/\d+\.jpg\?v=\d+/);
  });
});
