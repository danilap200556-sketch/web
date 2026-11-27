'use strict';
// Фильтры электроники по характеристикам: бренд -> линейка (iPhone, iPad, MacBook...) -> модель, память, SIM, связь, чип, диагональ, цвет.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client } = require('./helpers');

let shop;
let cat;
const get = async (qs) => (await client(shop.base).get(`/catalog?dept=elektronika${qs ? '&' + qs : ''}`)).text;
const names = (r) => r.items.map((m) => m.title).sort();
const search = (q) => cat.search({ dept: 'elektronika', ...q }, { pageSize: 100 });
const fac = (r, param) => Object.fromEntries(r.facets.specs[param]);

test.before(async () => {
  shop = await startShop('elfilters', { PARTNER_SYNC: 'off' });
  const add = (title, price, section = 'tekhnika-apple') => shop.db.query(
    "INSERT INTO webshop.ext_products (source, path, section, title, price, in_stock, images) VALUES ('sergeev', $1, $2, $3, $4, TRUE, '[\"https://x.test/a.jpg\"]'::jsonb)",
    [`p/${Math.random().toString(36).slice(2)}`, section, title, price]);
  for (const [t, pr, sec] of [
    ['Телефон Apple iPhone 16 128Gb SIM+eSIM (Black)', 79990], ['Телефон Apple iPhone 16 256Gb SIM+eSIM (White)', 89990], ['Телефон Apple iPhone 16 128Gb eSIM only (Black)', 76990],
    ['Смартфон Apple iPhone 17 Pro 256 ГБ eSIM Silver', 119990], ['Планшет Apple iPad Air 11 M2 128Gb Blue Wi-Fi', 64990], ['Планшет Apple iPad Air 11 M2 256Gb Blue Wi-Fi + Cellular', 79990],
    ['Ноутбук Apple MacBook Air 13 M3 16/512GB Space Gray', 129990], ['Моноблок Apple iMac 24 M4 16/256GB Blue', 169990], ['Умные часы Apple Watch Series 10 42mm GPS Gold Titanium', 49990],
    ['Наушники Apple AirPods Pro 3', 24990], ['Смартфон Samsung Galaxy S26 12/256GB Titanium Gray', 99990, 'tekhnika-samsung'], ['Телефон Samsung Galaxy A36 12/256GB Awesome Black', 39990, 'tekhnika-samsung'],
    ['Чехол Protect для iPhone 16 MagSafe Silicon Case', 2990, 'aksessuary'],
  ]) await add(t, pr, sec);
  cat = shop.services.catalog;
  cat.invalidate(); await cat.ensure();
});
test.after(async () => { await shop.stop(); });

test('аксессуар для iPhone - это аксессуар, а не смартфон, и не iPhone в фильтре', () => {
  const caseM = cat.models.find((m) => /Чехол/.test(m.title));
  assert.equal(caseM.type, 'Аксессуары');
  assert.equal(caseM.specs.family, undefined);
  const iphone = cat.models.find((m) => /iPhone 16 128Gb SIM\+eSIM/.test(m.title));
  assert.equal(iphone.type, 'Смартфоны');
  assert.deepEqual({ family: iphone.specs.family, storage: iphone.specs.storage, sim: iphone.specs.sim }, { family: 'iPhone', storage: '128 ГБ', sim: 'SIM + eSIM' });
});

test('у товаров не из электроники характеристик нет', async () => {
  const { addProduct } = require('./helpers');
  await addProduct(shop.db, { sku: 'NK-1_42', name: 'Кроссовки Nike Test «128GB»', price: 9000, qty: 2 });
  cat.invalidate(); await cat.ensure();
  const shoe = cat.models.find((m) => m.dept === 'shoes');
  assert.deepEqual(shoe.specs, {});
});

test('линейки не пропадают, когда выбраны характеристики: счётчики родителей не зависят от выбора потомков', () => {
  const r = search({ brand: 'Apple', fam: 'iPhone', mem: '128 ГБ', sim: 'eSIM' });
  assert.deepEqual(fac(r, 'fam'), { iPhone: 4, iPad: 2, MacBook: 1, iMac: 1, 'Apple Watch': 1, AirPods: 1 });
  assert.equal(r.total, 1);
  assert.ok(r.facets.brands.some(([b]) => b === 'Samsung'), 'бренды тоже считаются без выбранных характеристик');
});

test('бренд Apple: линейки со счётчиками, Samsung в них не попадает', () => {
  const r = search({ brand: 'Apple' });
  assert.deepEqual(fac(r, 'fam'), { iPhone: 4, iPad: 2, MacBook: 1, iMac: 1, 'Apple Watch': 1, AirPods: 1 });
});

test('линейка iPhone: память по возрастанию, SIM, модели, цвет; счётчики без собственной группы', () => {
  const r = search({ brand: 'Apple', fam: 'iPhone' });
  assert.equal(r.total, 4);
  assert.deepEqual(r.facets.specs.mem, [['128 ГБ', 2], ['256 ГБ', 2]]);
  assert.deepEqual(fac(r, 'sim'), { 'SIM + eSIM': 2, eSIM: 2 });
  assert.deepEqual(fac(r, 'model'), { 'iPhone 16': 3, 'iPhone 17 Pro': 1 });
  assert.deepEqual(fac(r, 'color'), { 'Чёрный': 2, 'Белый': 1, 'Серебристый': 1 });
  assert.equal(r.facets.specs.screen.length, 0, 'у iPhone диагонали и чипа нет');
});

test('несколько характеристик: внутри группы «или», между группами «и»; выбор не прячет соседние значения', () => {
  let r = search({ brand: 'Apple', fam: 'iPhone', mem: '128 ГБ' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.facets.specs.mem, [['128 ГБ', 2], ['256 ГБ', 2]], 'можно расширить выбор: 256 ГБ остаётся в списке');
  assert.deepEqual(fac(r, 'sim'), { 'SIM + eSIM': 1, eSIM: 1 }, 'SIM пересчитан под выбранную память');
  r = search({ brand: 'Apple', fam: 'iPhone', mem: ['128 ГБ', '256 ГБ'], sim: 'eSIM' });
  assert.deepEqual(names(r), ['Apple iPhone 16 128Gb eSIM only (Black)', 'Apple iPhone 17 Pro 256 ГБ eSIM Silver'].map((t) => cat.models.find((m) => m.fullName.endsWith(t)).title).sort());
  r = search({ brand: 'Apple', fam: ['iPhone', 'iPad'], mem: '128 ГБ' });
  assert.equal(r.total, 3, 'две линейки сразу: 2 iPhone и 1 iPad по 128 ГБ');
});

test('iPad и MacBook: свои характеристики - диагональ, чип, связь, оперативная память', () => {
  const ipad = search({ brand: 'Apple', fam: 'iPad' });
  assert.deepEqual(fac(ipad, 'screen'), { '11″': 2 });
  assert.deepEqual(fac(ipad, 'chip'), { M2: 2 });
  assert.deepEqual(fac(ipad, 'net'), { 'Wi-Fi': 1, 'Wi-Fi + Cellular': 1 });
  assert.equal(search({ brand: 'Apple', fam: 'iPad', net: 'Wi-Fi + Cellular' }).total, 1);
  const mac = search({ brand: 'Apple', fam: 'MacBook' });
  assert.deepEqual({ ram: fac(mac, 'ram'), mem: fac(mac, 'mem'), chip: fac(mac, 'chip'), screen: fac(mac, 'screen') },
    { ram: { '16 ГБ': 1 }, mem: { '512 ГБ': 1 }, chip: { M3: 1 }, screen: { '13″': 1 } });
});

test('условия по характеристикам берутся из адреса: незнакомые значения дают пустой результат, а не ошибку', () => {
  assert.equal(search({ fam: 'Несуществующая' }).total, 0);
  assert.doesNotThrow(() => search({ mem: ['x'.repeat(500)], fam: Array(50).fill('iPhone') }));
});

test('страница: после выбора бренда появляется строка «Линейка», после выбора линейки - характеристики кнопками', async () => {
  const brand = await get('brand=Apple');
  assert.match(brand, /quickbar__t">Линейка</);
  assert.match(brand, /href="\/catalog\?dept=elektronika&amp;brand=Apple&amp;fam=iPhone"[^>]*>iPhone <i>4<\/i>/);
  assert.doesNotMatch(brand, /quickbar__t">Память</, 'пока линейка не выбрана, характеристики кнопками не показываются');
  const fam = await get('brand=Apple&fam=iPhone');
  for (const t of ['Модель', 'Память', 'SIM']) assert.match(fam, new RegExp(`quickbar__t">${t}<`));
  assert.match(fam, /class="is-active"[^>]*>iPhone <i>4<\/i>/, 'выбранная линейка подсвечена');
  assert.match(fam, />128 ГБ <i>2<\/i>/);
  assert.match(fam, />SIM \+ eSIM <i>2<\/i>/);
});

test('каскад: смена линейки, бренда или категории сбрасывает характеристики прежнего выбора', async () => {
  const page = await get('brand=Apple&fam=iPhone&mem=128+%D0%93%D0%91&sim=eSIM');
  const hrefOf = (re) => { const m = re.exec(page); assert.ok(m, String(re)); return m[1].replace(/&amp;/g, '&'); };
  const ipad = hrefOf(/href="([^"]*)"[^>]*>iPad <i>/);
  assert.match(ipad, /fam=iPad/);
  assert.doesNotMatch(ipad, /mem=|sim=/, 'после выбора iPad память и SIM iPhone сброшены');
  const samsung = hrefOf(/href="([^"]*)"[^>]*>Samsung <i>/);
  assert.doesNotMatch(samsung, /fam=|mem=|sim=/, 'смена бренда сбрасывает линейку и характеристики');
  const all = hrefOf(/href="([^"]*)"[^>]*>Все <i>/);
  assert.doesNotMatch(all, /fam=|mem=/);
  const mem256 = hrefOf(/href="([^"]*)"[^>]*>256 ГБ <i>/);
  assert.match(mem256, /fam=iPhone/);
  assert.match(mem256, /sim=eSIM/, 'смена памяти не трогает остальные характеристики');
  assert.match(mem256, /mem=256/);
  assert.doesNotMatch(mem256, /mem=128/, 'выбор заменяет значение группы в кнопках: «повторное нажатие снимает», а соседнее выбирает вместо');
});

test('боковая панель: группы характеристик с галочками и счётчиками, выбранные отмечены, чипы можно снять', async () => {
  const all = await get('brand=Apple&fam=iPhone');
  for (const t of ['Линейка', 'Модель', 'Память', 'SIM', 'Цвет']) assert.match(all, new RegExp(`<summary>${t}</summary>`), t);
  const page = await get('brand=Apple&fam=iPhone&mem=128+%D0%93%D0%91');
  assert.match(page, /<input type="checkbox" name="mem" value="128 ГБ" checked><span>128 ГБ<\/span><i>2<\/i>/);
  assert.match(page, /<input type="checkbox" name="fam" value="iPhone" checked>/);
  assert.doesNotMatch(page, /<summary>Диагональ<\/summary>/, 'группа без выбора (меньше двух значений) не показывается');
  assert.doesNotMatch(page, /<summary>Модель<\/summary>/, 'у выбранной памяти одна модель: выбирать не из чего');
  assert.match(page, /class="fchip" href="[^"]*">128 ГБ/, 'чип выбранной памяти');
  // форма сортировки сохраняет выбранные характеристики
  assert.match(page, /<form method="get" action="\/catalog" class="sort"[\s\S]*?name="fam" value="iPhone"[\s\S]*?name="mem" value="128 ГБ"/);
});

test('страница с характеристиками не индексируется поисковиками; обычные категории без новых групп', async () => {
  assert.match(await get('brand=Apple&fam=iPhone'), /<meta name="robots" content="noindex, nofollow">/);
  const shoes = (await client(shop.base).get('/catalog?dept=obuv')).text;
  assert.doesNotMatch(shoes, /<summary>(Линейка|Память|SIM)<\/summary>/);
  assert.doesNotMatch(shoes, /quickbar__t">Линейка</);
});
