'use strict';
// Единый вид фото товаров: квадрат, чисто белый фон, товар по центру с одинаковыми полями.
//
// Фото приходят из разных мест: у одних серый или кремовый фон, у других товар прижат к краю. Здесь для снимков с ровным светлым фоном:
//  1) находится рамка товара (всё, что заметно отличается от цвета фона; слабые тени рамку не раздувают),
//  2) товар вырезается по рамке и ставится в центр квадрата так, чтобы занимать FILL его стороны,
//  3) фон выбеливается до чисто белого, а едва заметные тени и виньетка (почти белые пиксели) подтягиваются к белому.
// Снимки с пёстрым, тёмным или неровным фоном не обрезаются и не выбеливаются: их просто вписывают в белый квадрат.
// Убрать сложный фон автоматически нельзя: для этого нужен сервис удаления фона.
const sharp = require('sharp');

const FILL = 0.86;        // какую долю стороны квадрата занимает товар
const OBJ_DIFF = 34;      // чем сильнее пиксель отличается от фона, тем скорее он товар (тени слабее не считаются)
const SPREAD_MAX = 20;    // разброс цвета по четырём углам: больше - фон неровный
const MIN_LIGHT = 175;    // фон темнее не считаем «студийным»
const MAX_GAIN = 1.22;    // выбеливать можно, если фон не темнее примерно 209 из 255
const WORK = 1280;        // с таким размером читаем снимок для анализа и вырезания
const SOFT_FROM = 222;    // с какой светлоты пиксели начинают подтягиваться к белому
const SOFT_TO = 238;      // начиная с этой светлоты пиксель становится белым

function corners(data, W, H) {
  const N = Math.max(3, Math.min(14, Math.floor(Math.min(W, H) / 40)));
  const spots = [[0, 0], [W - N, 0], [0, H - N], [W - N, H - N]].map(([x0, y0]) => {
    const c = [0, 0, 0];
    for (let y = y0; y < y0 + N; y++) for (let x = x0; x < x0 + N; x++) { const i = (y * W + x) * 3; c[0] += data[i]; c[1] += data[i + 1]; c[2] += data[i + 2]; }
    return c.map((v) => v / (N * N));
  });
  const mean = [0, 1, 2].map((k) => spots.reduce((a, s) => a + s[k], 0) / 4);
  const spread = Math.max(...[0, 1, 2].map((k) => Math.max(...spots.map((s) => s[k])) - Math.min(...spots.map((s) => s[k]))));
  return { mean, spread };
}

// Рамка товара: первая и последняя строка и столбец, где есть хотя бы два заметных пикселя
function objectBox(data, W, H, bg) {
  const rows = new Uint16Array(H);
  const cols = new Uint16Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (Math.abs(data[i] - bg[0]) > OBJ_DIFF || Math.abs(data[i + 1] - bg[1]) > OBJ_DIFF || Math.abs(data[i + 2] - bg[2]) > OBJ_DIFF) { rows[y]++; cols[x]++; }
    }
  }
  const first = (arr) => arr.findIndex((v) => v >= 2);
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const x0 = first(cols); const x1 = last(cols); const y0 = first(rows); const y1 = last(rows);
  if (x0 < 0 || y0 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Почти белое становится белым: убирает едва заметные тени и виньетку. Между SOFT_FROM и SOFT_TO - плавный переход.
function softWhite(buf) {
  for (let i = 0; i < buf.length; i += 3) {
    const v = Math.min(buf[i], buf[i + 1], buf[i + 2]);
    if (v < SOFT_FROM) continue;
    const t = v >= SOFT_TO ? 1 : (v - SOFT_FROM) / (SOFT_TO - SOFT_FROM);
    buf[i] += (255 - buf[i]) * t; buf[i + 1] += (255 - buf[i + 1]) * t; buf[i + 2] += (255 - buf[i + 2]) * t;
  }
}

// input - файл картинки (JPEG, PNG, WebP...), size - сторона квадрата в пикселях. Возвращает { buf, type } или бросает ошибку на нечитаемом файле.
async function studio(input, size, webp = false) {
  const { data, info } = await sharp(input, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).removeAlpha()
    .resize({ width: WORK, height: WORK, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const { mean, spread } = corners(data, W, H);
  const lo = Math.min(...mean);
  const clean = spread <= SPREAD_MAX && lo >= MIN_LIGHT && Math.max(...mean) - lo <= 40;
  const encode = (img) => (webp ? img.webp({ quality: 82 }) : img.jpeg({ quality: 84, mozjpeg: true }));
  const type = webp ? 'image/webp' : 'image/jpeg';
  const rawIn = { raw: { width: W, height: H, channels: 3 } };

  if (!clean) {
    return { buf: await encode(sharp(data, rawIn).resize(size, size, { fit: 'contain', background: '#ffffff' })).toBuffer(), type };
  }

  let box = objectBox(data, W, H, mean);
  // Пустой кадр, шум или товар на весь кадр: рамкой не режем
  if (!box || box.w * box.h < W * H * 0.01) box = { x: 0, y: 0, w: W, h: H };
  const S = Math.max(box.w, box.h, 1) / FILL;
  const side = Math.ceil(S);
  const left = Math.floor((side - box.w) / 2);
  const top = Math.floor((side - box.h) / 2);
  const pad = { r: Math.round(mean[0]), g: Math.round(mean[1]), b: Math.round(mean[2]) };
  // sharp сначала режет, потом масштабирует, потом расширяет: поэтому кадр собираем отдельным проходом, а масштабируем уже готовый квадрат
  const framed = await sharp(data, rawIn).extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .extend({ top, bottom: side - box.h - top, left, right: side - box.w - left, background: pad }).raw().toBuffer({ resolveWithObject: true });
  let img = sharp(framed.data, { raw: { width: framed.info.width, height: framed.info.height, channels: 3 } }).resize(size, size, { fit: 'fill', kernel: 'lanczos3' });
  const gain = mean.map((m) => 255 / m);
  const whiten = lo >= 205 && Math.max(...gain) <= MAX_GAIN;
  if (whiten) img = img.linear(gain, [0, 0, 0]);
  if (!whiten) return { buf: await encode(img).toBuffer(), type };
  const out = await img.raw().toBuffer({ resolveWithObject: true });
  softWhite(out.data);
  return { buf: await encode(sharp(out.data, { raw: { width: out.info.width, height: out.info.height, channels: out.info.channels } })).toBuffer(), type };
}

module.exports = { studio };
