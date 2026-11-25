'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client } = require('./helpers');
const { typeOfTitle } = require('../src/ext');

test('типы электроники: VR-очки, консоли, часы, колонки', () => {
  assert.equal(typeOfTitle('Очки виртуальной реальности Meta Quest 3 512GB'), 'VR-очки');
  assert.equal(typeOfTitle('VR-гарнитура Apple Vision Pro'), 'VR-очки');
  assert.equal(typeOfTitle('Игровая консоль Sony PlayStation 5 Slim'), 'Игровые приставки');
  assert.equal(typeOfTitle('Умные часы Garmin Fenix 8'), 'Часы и браслеты');
  assert.equal(typeOfTitle('Колонка JBL Charge 6'), 'Колонки и звук');
});

test.describe('категории и бренды электроники кнопками', () => {
  let shop;
  const page = async (q = '') => (await client(shop.base).get(`/catalog?dept=elektronika${q}`)).text;
  test.before(async () => {
    shop = await startShop('ecat', { PARTNER_SYNC: 'on', PARTNER_AUTOSTART: 'off' });
    const add = (path, title, brand, price, stock = true) => shop.db.query(
      "INSERT INTO webshop.ext_products (source, path, section, title, brand, price, in_stock, images) VALUES ('sergeev', $1, 'x', $2, $3, $4, $5, '[\"https://x.test/a.jpg\"]'::jsonb)", [path, title, brand, price, stock]);
    await add('p/1', 'Смартфон Apple iPhone 17 256GB', 'Apple', 100000);
    await add('p/2', 'Смартфон Samsung Galaxy S26 Ultra 512GB', 'Samsung', 120000);
    await add('p/3', 'Наушники Apple AirPods Pro 3', 'Apple', 27000);
    await add('p/4', 'Пылесос Dyson V15 Detect', 'Dyson', 60000);
    await add('p/5', 'Колонка JBL Charge 6', 'JBL', 15000);
    await add('p/6', 'Очки виртуальной реальности Meta Quest 3', 'Meta', 50000);
    await add('p/7', 'Смартфон Apple iPhone 16 128GB', 'Apple', 70000, false);
  });
  test.after(async () => { await shop.stop(); });

  test('панель категорий: кнопки с числом товаров в наличии, «Все» активна без выбора', async () => {
    const t = await page();
    const bar = /<nav class="quickbar"[\s\S]*?<\/nav>/.exec(t)[0];
    assert.match(bar, /class="is-active"[^>]*>Все <i>6<\/i>/);
    assert.match(bar, />Смартфоны <i>2<\/i></, 'iPhone 16 нет в наличии: не считается');
    assert.match(bar, />Наушники <i>1<\/i></);
    assert.match(bar, />VR-очки <i>1<\/i></);
    assert.match(bar, />Колонки и звук <i>1<\/i></);
    assert.ok(bar.indexOf('Смартфоны') < bar.indexOf('Наушники'), 'сначала где больше товаров');
    assert.match(bar, /href="\/catalog\?dept=elektronika&amp;type=%D0%A1[^"]*"[^>]*>Смартфоны/);
  });

  test('выбранная категория подсвечена, повторное нажатие снимает её, бренды сужаются до категории', async () => {
    const t = await page('&type=%D0%A1%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B');
    const bar = /<nav class="quickbar"[\s\S]*?<\/nav>/.exec(t)[0];
    assert.match(bar, /class="is-active"[^>]*>Смартфоны <i>2<\/i>/);
    assert.match(bar, /<a href="\/catalog\?dept=elektronika"[^>]*>Все/, '«Все» сбрасывает категорию');
    assert.match(bar, />Apple <i>1<\/i></);
    assert.match(bar, />Samsung <i>1<\/i></);
    assert.doesNotMatch(bar, />Dyson </, 'Dyson телефонов не делает');
    assert.match(t, /Смартфон Samsung Galaxy S26 Ultra/);
    assert.doesNotMatch(t, /AirPods/, 'наушники отфильтрованы');
  });

  test('бренд кнопкой сочетается с категорией и снимается повторным нажатием', async () => {
    const t = await page('&type=%D0%A1%D0%BC%D0%B0%D1%80%D1%82%D1%84%D0%BE%D0%BD%D1%8B&brand=Samsung');
    const bar = /<nav class="quickbar"[\s\S]*?<\/nav>/.exec(t)[0];
    assert.match(bar, /class="is-active"[^>]*>Samsung/);
    assert.match(bar, /<a class="is-active" href="\/catalog\?dept=elektronika&amp;type=[^"&]+"[^>]*>Samsung/, 'нажатие на активный бренд убирает его из адреса');
    assert.doesNotMatch(t, /iPhone 17/);
  });

  test('в других отделах панели нет', async () => {
    assert.doesNotMatch((await client(shop.base).get('/catalog?dept=obuv')).text, /class="quickbar"/);
    assert.doesNotMatch((await client(shop.base).get('/catalog')).text, /class="quickbar"/);
  });
});
