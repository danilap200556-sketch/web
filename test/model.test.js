'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSku, parseName, deptOf, buildModels, sizeOrder } = require('../src/model');
const { quote, cityAllowed } = require('../src/delivery');
const { validateCheckout, OrderError } = require('../src/orders');
const { normalizePhone, rub, plural } = require('../src/util');
const { seasonOf } = require('../src/seasons');

test('артикул делится на модель и размер', () => {
  assert.deepEqual(splitSku('DD1391-100_42.5'), { key: 'DD1391-100', size: '42.5', note: '' });
  assert.deepEqual(splitSku('U9060SG_39'), { key: 'U9060SG', size: '39', note: '' });
  assert.deepEqual(splitSku('2048M1_L'), { key: '2048M1', size: 'L', note: '' });
  assert.equal(splitSku('0A27TP_ONE SIZE').size, 'ONE SIZE');
  assert.equal(splitSku('X_OS').size, 'ONE SIZE');
});

test('пометки у размера: без коробки, ширина, один кроссовок', () => {
  assert.equal(splitSku('M990BK6_44(2E)').note, '2E');
  assert.equal(splitSku('M990BK6_44(2E)').size, '44');
  assert.equal(splitSku('AB-1_42(б/к)').note, 'без коробки');
  assert.equal(splitSku('AB-1_38 (1 кроссовок)').note, 'один кроссовок');
  assert.equal(splitSku('AB-1_40.5(D)').note, 'D');
});

test('артикул без размера остаётся целиком', () => {
  assert.deepEqual(splitSku('ABC123'), { key: 'ABC123', size: '', note: '' });
  assert.equal(splitSku('ABC_xyz').key, 'ABC_xyz');
});

test('размеры сортируются: числа, потом буквы по ряду', () => {
  const l = ['44', 'XL', '38.5', 'M', '40', 'ONE SIZE', 'S'];
  assert.deepEqual(l.sort((a, b) => sizeOrder(a) - sizeOrder(b)), ['38.5', '40', '44', 'S', 'M', 'XL', 'ONE SIZE']);
});

test('название: тип, бренд, модель, расцветка', () => {
  assert.deepEqual(parseName('Кроссовки Nike Air Force 1 \'07 «Triple Black»'),
    { type: 'Кроссовки', brand: 'Nike', model: "Air Force 1 '07", colorway: 'Triple Black' });
  const nb = parseName('Кроссовки New Balance 9060 Magnet/Slate Grey');
  assert.equal(nb.brand, 'New Balance');
  assert.equal(nb.model, '9060 Magnet/Slate Grey');
  assert.equal(parseName('Кеды adidas Originals Samba OG').brand, 'adidas');
  assert.equal(parseName('Худи Carhartt WIP Chase').type, 'Худи');
  assert.equal(parseName('Спортивная куртка Stone Island').type, 'Спортивная куртка');
  // бренд «On» не должен находиться в начале «Onitsuka Tiger»
  assert.equal(parseName('Кроссовки Onitsuka Tiger Mexico 66').brand, 'Onitsuka Tiger');
  assert.equal(parseName('Кроссовки On Cloudtilt Glacier').brand, 'On');
});

test('бренд из карточки товара склада главнее угадывания', () => {
  assert.equal(parseName('Кроссовки Неизвестная Модель', 'Hoka').brand, 'Hoka');
  assert.equal(parseName('Кроссовки Nike Dunk', 'Hoka').brand, 'Nike');
});

test('отдел по типу и бренду', () => {
  assert.equal(deptOf('Кроссовки', 'Nike'), 'shoes');
  assert.equal(deptOf('Худи', 'Nike'), 'clothes');
  assert.equal(deptOf('Сумка', 'Longchamp'), 'accessories');
  assert.equal(deptOf('', 'Xiaomi'), 'electronics');
  assert.equal(deptOf('Наушники', 'Sony'), 'electronics');
});

test('размеры одной модели склеиваются; резерв вычитается из наличия', () => {
  const rows = [
    { id: 1, sku: 'DD1-100_41', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, vendor: '', created_at: '2026-10-01', qty: 2, photos: [] },
    { id: 2, sku: 'DD1-100_42', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, vendor: '', created_at: '2026-10-02', qty: 1, photos: [7, 8] },
    { id: 3, sku: 'DD1-100_43', name: 'Кроссовки Nike Dunk Low «Panda»', price: 12990, vendor: '', created_at: '2026-10-03', qty: 0, photos: [] },
    { id: 4, sku: 'NONAME_40', name: 'NONAME_40', price: 100, vendor: '', created_at: '2026-10-01', qty: 5, photos: [] },
  ];
  const [m, ...rest] = buildModels(rows, { reserved: new Map([[1, 1]]) });
  assert.equal(rest.length, 0, 'товар без названия на витрину не попадает');
  assert.equal(m.key, 'DD1-100');
  assert.equal(m.title, 'Nike Dunk Low');
  assert.equal(m.colorway, 'Panda');
  assert.deepEqual(m.sizes.map((s) => [s.size, s.qty]), [['41', 1], ['42', 1], ['43', 0]]);
  assert.equal(m.qty, 2);
  assert.equal(m.price, 11990, 'цена - минимальная среди размеров в наличии');
  assert.deepEqual(m.photos, [7, 8], 'берутся фото того размера, где их больше');
  assert.equal(m.cover, 7);
  assert.equal(m.inStock, true);
});

// ---- доставка и оформление ----
const methods = [
  { code: 'pickup', kind: 'pickup', title: 'Самовывоз', price: 0, door_extra: 0, free_from: null, cities: '', active: true },
  { code: 'courier', kind: 'courier', title: 'Курьер', price: 490, door_extra: 0, free_from: 15000, cities: 'Москва', active: true },
  { code: 'cdek', kind: 'tc', title: 'СДЭК', price: 390, door_extra: 250, free_from: 20000, cities: '', active: true },
];
const points = [{ id: 7, title: 'Магазин', address: 'Москва, Примерная 1', active: true }];
const base = { name: 'Анна', phone: '8 916 123-45-67', consent: '1', pay: 'online' };

test('стоимость доставки: порог бесплатной и доплата до двери', () => {
  assert.deepEqual(quote(methods[1], 14999, true), { price: 490, free: false });
  assert.deepEqual(quote(methods[1], 15000, true), { price: 0, free: true });
  assert.equal(quote(methods[2], 5000, false).price, 390);
  assert.equal(quote(methods[2], 5000, true).price, 640);
  assert.equal(quote(methods[0], 1000, false).price, 0);
});

test('город курьера сверяется без учёта регистра и ё', () => {
  assert.equal(cityAllowed(methods[1], 'москва'), true);
  assert.equal(cityAllowed(methods[1], 'Казань'), false);
  assert.equal(cityAllowed({ cities: 'Орёл' }, 'орел'), true);
  assert.equal(cityAllowed(methods[2], 'Любой'), true);
});

test('оформление: самовывоз требует пункт, итог считается на сервере', () => {
  assert.throws(() => validateCheckout({ ...base, delivery: 'pickup' }, methods, points, 10000), OrderError);
  const ok = validateCheckout({ ...base, delivery: 'pickup', point: '7' }, methods, points, 10000);
  assert.equal(ok.phone, '79161234567');
  assert.equal(ok.deliveryCost, 0);
  assert.equal(ok.total, 10000);
  assert.match(ok.point, /Магазин/);
});

test('оформление: курьер только в своём городе, нужен адрес', () => {
  assert.throws(() => validateCheckout({ ...base, delivery: 'courier', city: 'Казань', address: 'ул. Баумана, 1' }, methods, points, 10000), /работает только/);
  assert.throws(() => validateCheckout({ ...base, delivery: 'courier', city: 'Москва', address: '1' }, methods, points, 10000), /адрес/);
  const ok = validateCheckout({ ...base, delivery: 'courier', city: 'Москва', address: 'ул. Мира, 5, кв. 3' }, methods, points, 10000);
  assert.equal(ok.deliveryCost, 490);
  assert.equal(ok.total, 10490);
});

test('оформление: ТК - предоплата, до двери дороже, пункт выдачи обязателен', () => {
  assert.throws(() => validateCheckout({ ...base, delivery: 'cdek', city: 'Казань', mode: 'point', tcpoint: 'ул. Ленина 1', pay: 'cod' }, methods, points, 10000), /онлайн-оплата/);
  assert.throws(() => validateCheckout({ ...base, delivery: 'cdek', city: 'Казань', mode: 'point', tcpoint: '' }, methods, points, 10000), /пункт выдачи/i);
  const door = validateCheckout({ ...base, delivery: 'cdek', city: 'Казань', mode: 'door', address: 'ул. Баумана, 10, кв. 5' }, methods, points, 10000);
  assert.equal(door.deliveryCost, 640);
  const free = validateCheckout({ ...base, delivery: 'cdek', city: 'Казань', mode: 'point', tcpoint: 'СДЭК, Баумана 3' }, methods, points, 25000);
  assert.equal(free.deliveryCost, 0);
});

test('оформление: проверки контактов и согласия', () => {
  const m = { ...base, delivery: 'pickup', point: '7' };
  assert.throws(() => validateCheckout({ ...m, name: '' }, methods, points, 1), /обращаться/);
  assert.throws(() => validateCheckout({ ...m, phone: '123' }, methods, points, 1), /телефон/);
  assert.throws(() => validateCheckout({ ...m, email: 'not-an-email' }, methods, points, 1), /почты/);
  assert.throws(() => validateCheckout({ ...m, consent: '' }, methods, points, 1), /согласие/);
  assert.throws(() => validateCheckout({ ...m, delivery: 'nope' }, methods, points, 1), /способ доставки/);
  assert.throws(() => validateCheckout({ ...m, pay: 'bitcoin' }, methods, points, 1), /оплаты/);
});

test('утилиты: телефон, рубли, склонения, сезон', () => {
  assert.equal(normalizePhone('+7 (916) 123-45-67'), '79161234567');
  assert.equal(normalizePhone('9161234567'), '79161234567');
  assert.equal(normalizePhone('12345'), '');
  assert.equal(rub(12990).replace(/ /g, ' '), '12 990 ₽');
  assert.equal(plural(1, 'модель', 'модели', 'моделей'), 'модель');
  assert.equal(plural(3, 'модель', 'модели', 'моделей'), 'модели');
  assert.equal(plural(11, 'модель', 'модели', 'моделей'), 'моделей');
  assert.equal(plural(21, 'модель', 'модели', 'моделей'), 'модель');
  assert.equal(seasonOf(new Date('2026-01-15T12:00:00Z')), 'winter');
  assert.equal(seasonOf(new Date('2026-04-15T12:00:00Z')), 'spring');
  assert.equal(seasonOf(new Date('2026-07-15T12:00:00Z')), 'summer');
  assert.equal(seasonOf(new Date('2026-10-30T12:00:00Z')), 'autumn');
  assert.equal(seasonOf(new Date('2026-12-01T12:00:00Z')), 'winter');
});
