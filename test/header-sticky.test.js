'use strict';
// Закреплённая шапка: в Safari на iPhone верхняя панель браузера полупрозрачная, и над прилипшей шапкой просвечивала страница.
// Поэтому у прилипшей шапки фон продолжается вверх за край экрана (класс is-stuck ставит fx.js), а цвет панели браузера совпадает с шапкой.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startShop, client } = require('./helpers');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

test('фон шапки продолжается вверх, пока она прилипла, и не виден, пока она на месте', () => {
  const css = read('css/v4.css');
  assert.match(css, /\.head::before\s*\{[^}]*bottom:\s*100%[^}]*background:\s*var\(--night\)[^}]*visibility:\s*hidden/);
  assert.match(css, /\.head\.is-stuck::before\s*\{\s*visibility:\s*visible/);
});

test('fx.js ставит is-stuck, когда шапка у верхнего края, и снимает вверху страницы', () => {
  const js = read('js/fx.js');
  assert.match(js, /classList\.toggle\('is-stuck',\s*y\s*>\s*0\s*&&\s*head\.getBoundingClientRect\(\)\.top\s*<=\s*1\)/);
});

test('цвет панели браузера (theme-color) совпадает с цветом шапки', async () => {
  const shop = await startShop('stickyhead');
  try {
    const page = (await client(shop.base).get('/')).text;
    assert.match(page, /<meta name="theme-color" content="#0b0b0b">/);
    assert.match(read('css/v4.css'), /--night:\s*#0b0b0b/);
  } finally { await shop.stop(); }
});
