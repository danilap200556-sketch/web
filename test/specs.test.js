'use strict';
// Характеристики электроники из названия: линейка (iPhone, iPad, MacBook...), модель, память, SIM, связь, чип, диагональ, корпус, цвет.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpecs, SPEC_FACETS, byStorage } = require('../src/specs');

const p = (title, extra = {}) => parseSpecs({ title, brand: '', type: '', ...extra });
const pick = (s, keys) => Object.fromEntries(keys.map((k) => [k, s[k]]));

test('iPhone: линейка, модель, память, SIM и цвет из разных вариантов названия', () => {
  assert.deepEqual(pick(p('Телефон Apple iPhone 16 128Gb SIM+eSIM (Black)'), ['family', 'line', 'storage', 'sim', 'color']),
    { family: 'iPhone', line: 'iPhone 16', storage: '128 ГБ', sim: 'SIM + eSIM', color: 'Чёрный' });
  assert.deepEqual(pick(p('iPhone 18 Pro 256 ГБ Burgundy eSIM'), ['family', 'line', 'storage', 'sim', 'color']),
    { family: 'iPhone', line: 'iPhone 18 Pro', storage: '256 ГБ', sim: 'eSIM', color: 'Бордовый' });
  assert.deepEqual(pick(p('Телефон Apple iPhone Pro Max 16 256Gb eSIM only (Black Titanium)'), ['line', 'storage', 'sim', 'color']),
    { line: 'iPhone 16 Pro Max', storage: '256 ГБ', sim: 'eSIM', color: 'Чёрный' }, 'порядок слов в названии у магазинов разный');
  assert.equal(p('Смартфон Apple iPhone Air 256 ГБ Cloud White').line, 'iPhone Air');
  assert.equal(p('Смартфон Apple iPhone 16e 128 ГБ Black').line, 'iPhone 16e');
  assert.equal(p('Apple iPhone SE 64GB').line, 'iPhone SE');
  assert.equal(p('Apple iPhone 15 Plus 128GB Pink').line, 'iPhone 15 Plus');
  assert.equal(p('Смартфон Apple iPhone 17 Pro Max 1 ТБ Silver SIM+eSIM').storage, '1 ТБ');
  assert.equal(p('Телефон Apple iPhone 17 Pro Max 2TB Deep Blue').storage, '2 ТБ');
  assert.equal(p('Телефон Apple iPhone 16 128Gb Dual SIM (White)').sim, 'Dual SIM');
  assert.equal(p('Телефон Apple iPhone 15 128GB Nano SIM Blue').sim, 'SIM');
  assert.equal(p('Телефон Apple iPhone 16 128Gb SIM-eSIM Black').sim, 'SIM + eSIM');
  assert.equal(p('Телефон Apple iPhone 16 128Gb Black').sim, undefined, 'SIM не указана - значения нет, а не «SIM»');
  // iPhone 16 с памятью: «16» - поколение, а не оперативная память
  assert.equal(p('Телефон Apple iPhone 16 128Gb Black').ram, undefined);
});

test('iPad: линейка, диагональ, чип, связь', () => {
  assert.deepEqual(pick(p('Планшет Apple iPad Air 11 M2 128Gb Blue Wi-Fi'), ['family', 'line', 'storage', 'screen', 'chip', 'net', 'color']),
    { family: 'iPad', line: 'iPad Air', storage: '128 ГБ', screen: '11″', chip: 'M2', net: 'Wi-Fi', color: 'Синий' });
  assert.deepEqual(pick(p('Apple iPad Pro 11 M5 512GB Space Black Wi-Fi + Cellular'), ['line', 'storage', 'screen', 'chip', 'net', 'color']),
    { line: 'iPad Pro', storage: '512 ГБ', screen: '11″', chip: 'M5', net: 'Wi-Fi + Cellular', color: 'Чёрный' });
  const mini = p('Планшет iPad mini 7 2024 Wi-Fi 128 GB Purple');
  assert.deepEqual(pick(mini, ['line', 'storage', 'net', 'color', 'screen']), { line: 'iPad mini', storage: '128 ГБ', net: 'Wi-Fi', color: 'Фиолетовый', screen: undefined });
  assert.equal(p('Apple iPad 10.9 64GB Silver Wi-Fi').screen, '10.9″');
  assert.equal(p('Apple iPad 10 64GB Silver Wi-Fi').screen, undefined, '«10» - поколение, а не диагональ');
  assert.equal(p('Apple iPad 10 64GB Silver Wi-Fi').line, 'iPad');
  assert.equal(p('Apple iPad Air 13 M3 256GB Gray Wi-Fi 5G').net, 'Wi-Fi + Cellular');
});

test('Mac: MacBook, iMac, Mac mini - линейка, диагональ, чип, оперативная и встроенная память', () => {
  assert.deepEqual(pick(p('Ноутбук Apple MacBook Air 13 M3 16/512GB Space Gray'), ['family', 'line', 'screen', 'chip', 'ram', 'storage', 'color']),
    { family: 'MacBook', line: 'MacBook Air', screen: '13″', chip: 'M3', ram: '16 ГБ', storage: '512 ГБ', color: 'Серый' });
  assert.deepEqual(pick(p('Apple MacBook Pro 14 M4 Pro 24/512GB Space Black'), ['line', 'screen', 'chip', 'ram', 'storage']),
    { line: 'MacBook Pro', screen: '14″', chip: 'M4 Pro', ram: '24 ГБ', storage: '512 ГБ' });
  assert.deepEqual(pick(p('Apple MacBook Pro 14 M5 16 1TB Silver'), ['screen', 'chip', 'ram', 'storage']), { screen: '14″', chip: 'M5', ram: '16 ГБ', storage: '1 ТБ' });
  assert.deepEqual(pick(p('Apple MacBook Air 13 M4 16 256gb Star Light'), ['screen', 'ram', 'storage']), { screen: '13″', ram: '16 ГБ', storage: '256 ГБ' });
  assert.deepEqual(pick(p('Настольный компьютер Apple Mac mini M4 10C CPU 10C GPU 16GB 256GB SSD серебристый'), ['family', 'chip', 'ram', 'storage', 'color']),
    { family: 'Mac mini', chip: 'M4', ram: '16 ГБ', storage: '256 ГБ', color: 'Серебристый' });
  assert.deepEqual(pick(p('Настольный компьютер Apple Mac mini M4 Pro 12C CPU 16C GPU 64GB 1TB SSD'), ['chip', 'ram', 'storage']), { chip: 'M4 Pro', ram: '64 ГБ', storage: '1 ТБ' });
  assert.deepEqual(pick(p('Моноблок Apple iMac 24 M4 16/256GB Blue'), ['family', 'screen', 'chip', 'ram', 'storage']), { family: 'iMac', screen: '24″', chip: 'M4', ram: '16 ГБ', storage: '256 ГБ' });
});

test('часы и наушники Apple', () => {
  assert.deepEqual(pick(p('Умные часы Apple Watch Series 10 42mm Gold Titanium'), ['family', 'line', 'case', 'color']),
    { family: 'Apple Watch', line: 'Series 10', case: '42 мм', color: 'Золотой' });
  assert.deepEqual(pick(p('Apple Watch Ultra 2 49mm Natural Titanium Indigo Alpine Loop'), ['line', 'case', 'color']), { line: 'Ultra 2', case: '49 мм', color: 'Натуральный титан' });
  assert.equal(p('Apple Watch SE 2024 44mm Silver Sport Band').line, 'SE');
  assert.equal(p('Apple Watch S11 42 mm Gold Titanium').line, 'Series 11');
  assert.equal(p('Apple Watch Series 11 46mm GPS + Cellular Black').net, 'GPS + Cellular');
  assert.equal(p('Apple Watch Series 11 46mm GPS Black').net, 'GPS');
  assert.deepEqual(pick(p('Наушники Apple AirPods Pro 3'), ['family', 'line']), { family: 'AirPods', line: 'AirPods Pro 3' });
  assert.equal(p('Apple AirPods 4 с шумоподавлением').line, 'AirPods 4');
  assert.deepEqual(pick(p('Наушники Apple AirPods Max USB-C Purple'), ['line', 'color']), { line: 'AirPods Max', color: 'Фиолетовый' });
  assert.equal(p('Apple AirTag 4 Pack').family, 'AirTag');
});

test('Samsung Galaxy: линейки и модели, оперативная и встроенная память', () => {
  assert.deepEqual(pick(p('Смартфон Samsung Galaxy S26 Ultra 12/256GB Titanium Gray'), ['family', 'line', 'ram', 'storage', 'color']),
    { family: 'Galaxy S', line: 'Galaxy S26 Ultra', ram: '12 ГБ', storage: '256 ГБ', color: 'Серый' });
  assert.deepEqual(pick(p('Телефон Samsung Galaxy A36 12/256GB Awesome Black'), ['family', 'line', 'color']), { family: 'Galaxy A', line: 'Galaxy A36', color: 'Чёрный' });
  assert.equal(p('Samsung Galaxy S25 FE 8/128GB Navy').line, 'Galaxy S25 FE');
  assert.deepEqual(pick(p('Планшет Samsung Galaxy Tab S11 Ultra 16/1TB Gray Wi-Fi'), ['family', 'line', 'ram', 'storage', 'net']),
    { family: 'Galaxy Tab', line: 'Galaxy Tab S11 Ultra', ram: '16 ГБ', storage: '1 ТБ', net: 'Wi-Fi' });
  assert.equal(p('Samsung Galaxy Tab S11 12/256GB Silver 5G').net, 'Wi-Fi + Cellular');
  assert.deepEqual(pick(p('Умные часы Samsung Galaxy Watch 7 40mm LTE Cream'), ['family', 'line', 'case', 'net']),
    { family: 'Galaxy Watch', line: 'Galaxy Watch 7', case: '40 мм', net: 'GPS + Cellular' });
  assert.equal(p('Samsung Galaxy Z Fold7 12/256GB Blue Shadow').family, 'Galaxy Z');
  assert.equal(p('Samsung Galaxy Z Fold7 12/256GB Blue Shadow').line, 'Galaxy Z Fold7');
  assert.deepEqual(pick(p('Наушники Samsung Galaxy Buds3 Pro Silver'), ['family', 'line']), { family: 'Galaxy Buds', line: 'Galaxy Buds3 Pro' });
});

test('другие бренды: Pixel, Xiaomi, Dyson, DJI', () => {
  assert.deepEqual(pick(p('Google Pixel 10 Pro XL 16/256GB Moonstone'), ['family', 'line', 'ram', 'storage']), { family: 'Pixel', line: 'Pixel 10 Pro XL', ram: '16 ГБ', storage: '256 ГБ' });
  assert.deepEqual(pick(p('Смартфон Xiaomi 17 12/256GB Ice Blue'), ['family', 'ram', 'storage', 'color']), { family: 'Xiaomi', ram: '12 ГБ', storage: '256 ГБ', color: 'Голубой' });
  assert.equal(p('Смартфон Xiaomi Redmi Note 14 Pro 8/256GB Black').family, 'Redmi Note');
  assert.equal(p('Фен Dyson Supersonic Nural HD16 Ceramic Patina Topaz').family, 'Supersonic');
  assert.equal(p('Стайлер Dyson Airwrap i.d. Straight+Wavy Ceramic Pop').family, 'Airwrap');
  assert.equal(p('Пылесос Dyson V12 Detect Slim').family, 'Пылесосы');
  assert.equal(p('Экшн-камера DJI Osmo Action 5 Pro Adventure Combo').family, 'Osmo Action');
});

test('аксессуары для техники не считаются самой техникой; пустое и странное не ломает разбор', () => {
  const case1 = p('Чехол Protect для iPhone 16 Pro MagSafe Silicon Case Aquamarine', { type: 'Аксессуары' });
  assert.equal(case1.family, undefined, 'чехол для iPhone - не iPhone');
  assert.equal(case1.storage, undefined);
  assert.deepEqual(p(''), {});
  assert.deepEqual(p(null), {});
  assert.deepEqual(p('Какая-то штука без характеристик'), {});
  assert.doesNotThrow(() => p('12/8/4 256/512 1TB 2TB 13 14 15 16 M9 M0 Wi-Fi LTE SIM eSIM'));
  assert.equal(p('Флешка 128GB', { type: 'Аксессуары' }).storage, '128 ГБ', 'память у аксессуара можно фильтровать, но линейки нет');
});

test('описание фильтров: ключи параметров не повторяются, у каждого есть название и поле', () => {
  const params = SPEC_FACETS.map((f) => f.param);
  assert.equal(new Set(params).size, params.length);
  for (const f of SPEC_FACETS) { assert.ok(f.title && f.field && f.crit, f.param); }
  assert.deepEqual(['1 ТБ', '128 ГБ', '2 ТБ', '64 ГБ', '512 ГБ', '256 ГБ'].sort(byStorage), ['64 ГБ', '128 ГБ', '256 ГБ', '512 ГБ', '1 ТБ', '2 ТБ']);
});
