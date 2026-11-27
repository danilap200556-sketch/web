'use strict';
// Поиск логотипа BAZA на фото: значок-«плей» (синий контур треугольника с маленьким сплошным треугольником внутри).
// Картинки рисуются здесь же (чужие фото в тестах не нужны).
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { hasBazaLogo } = require('../src/logoscan');

const BLUE = '#1e6fd9';
// Значок высотой h пикселей в точке (x, y): контур треугольника + маленький сплошной внутри
const icon = (x, y, h, color = BLUE) => {
  const w = h * 0.67; const t = Math.max(3, h * 0.07);
  return `<polygon points="${x},${y} ${x},${y + h} ${x + w},${y + h / 2}" fill="none" stroke="${color}" stroke-width="${t}" stroke-linejoin="miter"/>
    <polygon points="${x + w * 0.3},${y + h * 0.33} ${x + w * 0.3},${y + h * 0.67} ${x + w * 0.65},${y + h * 0.5}" fill="${color}"/>`;
};
const letters = (x, y, h, color = '#cfcfcf') => [0, 1, 2, 3].map((i) => `<rect x="${x + i * h * 0.55}" y="${y + h * 0.15}" width="${h * 0.38}" height="${h * 0.7}" fill="${color}"/>`).join('');
const img = async (inner, { bg = '#ffffff', w = 1000, h = 1000, fmt = 'jpeg' } = {}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${inner}</svg>`;
  const s = sharp(Buffer.from(svg));
  return fmt === 'png' ? s.png().toBuffer() : s.jpeg({ quality: 90 }).toBuffer();
};

test('значок BAZA найден: на тёмном и белом фоне, разного размера, в JPEG и PNG', async () => {
  assert.equal(await hasBazaLogo(await img(icon(300, 600, 120) + letters(400, 600, 120), { bg: '#16181d' })), true, 'тёмный корпус');
  assert.equal(await hasBazaLogo(await img(icon(300, 600, 120) + letters(400, 600, 120, '#e8e8e8'), { bg: '#f2f2f2' })), true, 'белый корпус: буквы бледные, значок синий');
  assert.equal(await hasBazaLogo(await img(icon(200, 300, 70) + letters(260, 300, 70))), true, 'мелкий');
  assert.equal(await hasBazaLogo(await img(icon(200, 200, 260), { fmt: 'png' })), true, 'крупный, PNG');
  assert.equal(await hasBazaLogo(await img(icon(700, 80, 250), { w: 1920, h: 1920 })), true, 'большой снимок уменьшается до разбора');
});

test('синее без значка логотипом не считается: экран, кабель, одинокий контур, чужой оттенок', async () => {
  assert.equal(await hasBazaLogo(await img('<rect x="200" y="200" width="500" height="600" rx="40" fill="#1e6fd9"/>')), false, 'синий экран целиком');
  assert.equal(await hasBazaLogo(await img(`<polygon points="300,300 300,420 380,360" fill="none" stroke="${BLUE}" stroke-width="9"/>`)), false, 'контур без вложенного треугольника');
  assert.equal(await hasBazaLogo(await img(`<polygon points="300,300 300,420 380,360" fill="none" stroke="${BLUE}" stroke-width="9"/><polygon points="700,700 700,740 730,720" fill="${BLUE}"/>`)), false, 'сплошной треугольник не внутри контура');
  assert.equal(await hasBazaLogo(await img(icon(300, 300, 120, '#2828c8'))), false, 'сине-фиолетовый (подсветка, провод): другой оттенок');
  assert.equal(await hasBazaLogo(await img(icon(300, 300, 120, '#c83030'))), false, 'красный');
  assert.equal(await hasBazaLogo(await img(`<path d="M100 800 C 300 200, 600 200, 900 800" fill="none" stroke="${BLUE}" stroke-width="30"/>`)), false, 'дуга');
});

test('нечитаемое, пустое и случайное не ломает проверку', async () => {
  assert.equal(await hasBazaLogo(Buffer.from('это не картинка')), false);
  assert.equal(await hasBazaLogo(Buffer.alloc(0)), false);
  assert.equal(await hasBazaLogo(null), false);
  const noise = await sharp({ create: { width: 600, height: 600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).jpeg().toBuffer();
  assert.equal(await hasBazaLogo(noise), false);
});
