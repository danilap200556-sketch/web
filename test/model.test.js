'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSku, parseName, deptOf, deptOfModel, buildModels, sizeOrder } = require('../src/model');
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

test('хвост, похожий на размер только началом, размером не считается', () => {
  assert.equal(splitSku('ABC_SALE').key, 'ABC_SALE');
  assert.equal(splitSku('NIKE_SMALL').key, 'NIKE_SMALL');
  assert.equal(splitSku('X_425').key, 'X_425');
  assert.equal(splitSku('X_XL (б/к)').size, 'XL');
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

test('отдел находится и когда название не начинается со слова-типа', () => {
  const d = (name, extra = {}) => { const p = parseName(name); return deptOfModel({ type: p.type, brand: p.brand, name, category: '', sizes: [], ...extra }); };
  assert.equal(d('Кроссовки Nike Dunk Low'), 'shoes'); // тип в начале - как раньше
  assert.equal(d('Мужские кроссовки Nike Air Force 1'), 'shoes');
  assert.equal(d('Nike Air Force 1 кеды женские'), 'shoes');
  assert.equal(d('Nike Tech Fleece худи'), 'clothes');
  assert.equal(d('Мужская футболка Stussy'), 'clothes');
  assert.equal(d('Беспроводные наушники Sony WH-1000XM5'), 'electronics');
  assert.equal(d('Nike Dunk Low', { category: 'Кроссовки и кеды' }), 'shoes'); // категория Маркета
  assert.equal(d('Nike Tech', { category: 'Футболки и майки' }), 'clothes');
  // без признаков в тексте решают размеры из артикулов, иначе - аксессуары
  assert.equal(d('New Balance 550 White Green', { sizes: ['41', '42', '43.5'] }), 'shoes');
  assert.equal(d('Nike Tech Fleece', { sizes: ['S', 'M', 'L'] }), 'clothes');
  assert.equal(d('Nike Heritage', { sizes: ['ONE SIZE'] }), 'accessories');
  assert.equal(d('New Balance 550 White Green'), 'accessories');
  // слова-двойники не путаются с типами
  assert.equal(d('Кедровый орех'), 'accessories');
  assert.equal(d('Полотенце Nike'), 'accessories');
  assert.equal(d('Майкл Корс Jet Set'), 'accessories');
});

test('отдел модели учитывает категорию Маркета и размеры при сборке', () => {
  const rows = [
    { id: 1, sku: 'NB550-WG_41', name: 'New Balance 550 White Green', price: 9000, vendor: '', category: '', created_at: '2026-10-01', qty: 1, photos: [1] },
    { id: 2, sku: 'NB550-WG_42', name: 'New Balance 550 White Green', price: 9000, vendor: '', category: '', created_at: '2026-10-01', qty: 1, photos: [1] },
    { id: 3, sku: 'TF-1_M', name: 'Nike Tech Fleece', price: 7000, vendor: '', category: '', created_at: '2026-10-01', qty: 1, photos: [2] },
    { id: 4, sku: 'DUNK-1_41', name: 'Nike Dunk Low Panda', price: 9000, vendor: '', category: 'Кроссовки', created_at: '2026-10-01', qty: 1, photos: [3] },
  ];
  const byKey = Object.fromEntries(buildModels(rows).map((m) => [m.key, m.dept]));
  assert.deepEqual(byKey, { 'NB550-WG': 'shoes', 'TF-1': 'clothes', 'DUNK-1': 'shoes' });
});

test('двойной размер одежды L/XL и M/L - это размер, а не пометка', () => {
  assert.deepEqual(splitSku('DC9165-328_L/XL'), { key: 'DC9165-328', size: 'L/XL', note: '' });
  assert.deepEqual(splitSku('FB5375-716_M/L'), { key: 'FB5375-716', size: 'M/L', note: '' });
  assert.equal(splitSku('AB-1_42(б/к)').size, '42', 'а «б/к» по-прежнему пометка');
});

test('на витрине размер - только цифра или буква: варианты с пометками не продаются, ширина D обычная', () => {
  const name = 'Кроссовки Nike Dunk Low «Panda»';
  const row = (id, sku, qty, price = 10000) => ({ id, sku, name, price, vendor: '', created_at: '2026-10-01', qty, photos: [1] });
  const rows = [row(1, 'DD1-100_41', 2), row(2, 'DD1-100_42', 1), row(3, 'DD1-100_42(б/к)', 3, 8000), row(4, 'DD1-100_43(1 кроссовок)', 1),
    row(5, 'DD1-100_44(D)', 2), row(6, 'DD1-100_45(Брак)', 1), row(7, 'DD1-100_46(2E)', 1)];
  const m = buildModels(rows)[0];
  assert.deepEqual(m.sizes.map((x) => x.label), ['41', '42', '44'], 'остались только обычные размеры, подписи без слов');
  assert.ok(m.sizes.every((x) => /^[\dA-Z./]+$/.test(x.label)), 'в подписях нет слов');
  assert.equal(m.sizes.find((x) => x.size === '42').id, 2, 'при пересечении берётся вариант без пометки');
  assert.equal(m.sizes.find((x) => x.size === '44').id, 5, 'D - обычная ширина');
  assert.equal(m.price, 10000, 'цена «без коробки» не занижает цену модели');
  // с включённой настройкой варианты с пометками тоже продаются, но подпись остаётся без слов
  const all = buildModels(rows, { showNoteSizes: true })[0];
  assert.deepEqual(all.sizes.map((x) => x.label), ['41', '42', '43', '44', '45', '46']);
  assert.equal(all.sizes.find((x) => x.size === '42').id, 2, 'и тут обычный вариант главнее');
  // только варианты с пометками: модель есть, размеров нет
  const only = buildModels([row(9, 'ZZ-1_42(б/к)', 1)])[0];
  assert.deepEqual(only.sizes, []);
  assert.equal(only.noteOnly, true);
  assert.equal(buildModels([row(9, 'ZZ-1_42(б/к)', 1)], { showNoteSizes: true })[0].noteOnly, false);
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
const base = { name: 'Анна', phone: '8 916 123-45-67', consent: '1', pay: 'sbp' };

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
  assert.throws(() => validateCheckout({ ...base, delivery: 'cdek', city: 'Казань', mode: 'point', tcpoint: 'ул. Ленина 1', pay: 'cod' }, methods, points, 10000), /предоплата/);
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
