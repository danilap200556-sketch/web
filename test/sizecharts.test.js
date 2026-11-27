'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct } = require('./helpers');
const { chartFor, parseEu, CHARTS, APPAREL } = require('../src/sizecharts');

test('бренд определяет таблицу: Nike и Jordan, adidas и Yeezy, New Balance, остальные - универсальная с названием бренда', () => {
  assert.equal(chartFor('Nike').key, 'nike');
  assert.equal(chartFor('Air Jordan').key, 'nike');
  assert.equal(chartFor('Jordan').key, 'nike');
  assert.equal(chartFor('adidas Originals').key, 'adidas');
  assert.equal(chartFor('Yeezy').key, 'adidas');
  assert.equal(chartFor('New Balance').key, 'newbalance');
  const ugg = chartFor('UGG');
  assert.equal(ugg.key, 'universal');
  assert.match(ugg.note, /UGG/);
  assert.equal(chartFor('').key, 'universal');
  assert.equal(chartFor(undefined).key, 'universal');
});

test('размер EU: дроби adidas читаются как числа', () => {
  assert.equal(parseEu('42'), 42);
  assert.equal(parseEu('42.5'), 42.5);
  assert.ok(Math.abs(parseEu('38 2/3') - 38.6667) < 0.001);
  assert.ok(Math.abs(parseEu('41 1/3') - 41.3333) < 0.001);
  assert.ok(Number.isNaN(parseEu('M')));
});

test('Nike: строки совпадают с официальной таблицей nike.com (мужская US, женская US, UK, EU, см)', () => {
  const nike = CHARTS.find((c) => c.key === 'nike');
  const row = (eu) => nike.rows.find((r) => r.eu === eu);
  assert.deepEqual(row('40'), { eu: '40', usM: '7', usW: '8.5', uk: '6', cm: '25' });
  assert.deepEqual(row('42'), { eu: '42', usM: '8.5', usW: '10', uk: '7.5', cm: '26.5' });
  assert.deepEqual(row('42.5'), { eu: '42.5', usM: '9', usW: '10.5', uk: '8', cm: '27' });
  assert.deepEqual(row('44'), { eu: '44', usM: '10', usW: '11.5', uk: '9', cm: '28' });
  assert.deepEqual(row('47.5'), { eu: '47.5', usM: '13', usW: '14.5', uk: '12', cm: '31' });
  assert.equal(row('35.5').usM, '3.5');
});

test('целостность таблиц: размеры и длина стопы не убывают, нет повторов, у каждой строки все колонки', () => {
  for (const chart of CHARTS) {
    assert.ok(chart.title && chart.rows.length >= 10, chart.key);
    let prevEu = 0;
    let prevCm = 0;
    const seen = new Set();
    for (const r of chart.rows) {
      for (const k of ['eu', 'usM', 'usW', 'uk', 'cm']) assert.ok(r[k] !== undefined && r[k] !== '', `${chart.key}: ${JSON.stringify(r)} без ${k}`);
      assert.ok(parseEu(r.eu) > prevEu, `${chart.key}: EU ${r.eu} не растёт`);
      assert.ok(parseFloat(r.cm) >= prevCm, `${chart.key}: см ${r.cm} убывает`);
      assert.ok(!seen.has(r.eu), `${chart.key}: повтор ${r.eu}`);
      seen.add(r.eu);
      prevEu = parseEu(r.eu);
      prevCm = parseFloat(r.cm);
    }
  }
  assert.ok(APPAREL.men.length >= 5 && APPAREL.women.length >= 5);
});

test.describe('таблицы размеров в магазине', () => {
  let shop, nikeSlug, adidasSlug, uggSlug, shirtSlug, capSlug;
  const get = async (p) => (await client(shop.base).get(p)).text;
  const slugOf = async (sku) => { shop.services.catalog.invalidate(); await shop.services.catalog.ensure(); return shop.services.catalog.models.find((m) => m.sizes.some((s) => s.sku.startsWith(sku))).slug; };

  test.before(async () => {
    shop = await startShop('sizecharts');
    await addProduct(shop.db, { sku: 'NK-1_42', name: 'Кроссовки Nike Air Max 90', price: 12000, qty: 3, vendor: 'Nike' });
    await addProduct(shop.db, { sku: 'NK-1_43', name: 'Кроссовки Nike Air Max 90', price: 12000, qty: 0, vendor: 'Nike' });
    await addProduct(shop.db, { sku: 'AD-1_42', name: 'Кроссовки adidas Samba OG', price: 9000, qty: 2, vendor: 'adidas' });
    await addProduct(shop.db, { sku: 'UG-1_38', name: 'Ботинки UGG Classic Mini', price: 15000, qty: 2, vendor: 'UGG' });
    await addProduct(shop.db, { sku: 'TS-1_M', name: 'Футболка Nike Sportswear Tee', price: 3000, qty: 4, vendor: 'Nike', category: 'Футболки' });
    await addProduct(shop.db, { sku: 'CP-1', name: 'Кепка Nike Heritage86', price: 2000, qty: 5, vendor: 'Nike', category: 'Аксессуары' });
    nikeSlug = await slugOf('NK-1'); adidasSlug = await slugOf('AD-1'); uggSlug = await slugOf('UG-1'); shirtSlug = await slugOf('TS-1'); capSlug = await slugOf('CP-1');
  });
  test.after(async () => { await shop.stop(); });

  test('карточка обуви: кнопка у выбора размера и окно с сеткой EU бренда, размеры в наличии помечены', async () => {
    const page = await get(`/p/${nikeSlug}`);
    assert.match(page, /<button class="sizelink sizelink--btn" type="button" data-sizeguide-open[^>]*>Таблица размеров<\/button>/);
    assert.match(page, /<dialog class="sizesheet" data-sizesheet/);
    assert.match(page, /Выберите ваш размер и мы покажем соответствия подходящего размера других стран/);
    assert.match(page, /Европейский - EU/);
    assert.match(page, /Nike и Jordan/);
    const cell = (eu) => new RegExp(`<button class="sz( is-have)?" type="button" data-sz data-eu="${eu}" data-have="([01])"[^>]*>`).exec(page);
    assert.equal(cell('42')[2], '1', 'размер 42 есть в наличии');
    assert.match(cell('42')[0], /class="sz is-have"/);
    assert.equal(cell('43')[2], '0', 'размер 43 раскуплен');
    assert.doesNotMatch(cell('43')[0], /is-have/);
    assert.equal((page.match(/<button class="sz[ "]/g) || []).length, CHARTS[0].rows.length, 'в сетке все размеры таблицы бренда');
    assert.match(page, /href="\/razmery"/);
    assert.doesNotMatch(page, /<summary>Таблица размеров<\/summary>[\s\S]*Nike и Jordan/, 'старой раскрывающейся таблицы у обуви больше нет');
  });

  test('соответствия размеров: RU, US (муж. и жен.), UK, FR и длина стопы лежат в самой плитке, дробные EU у adidas читаются', async () => {
    const nike = await get(`/p/${nikeSlug}`);
    const c42 = /<button class="sz[^"]*" type="button" data-sz data-eu="42"[^>]*>/.exec(nike)[0];
    for (const [k, v] of [['ru', '42'], ['us-m', '8,5'], ['us-w', '10'], ['uk', '7,5'], ['fr', '42'], ['cm', '26,5']]) assert.ok(c42.includes(`data-${k}="${v}"`), `${k}=${v} в ${c42}`);
    for (const t of ['Российский (RU)', 'Американский (US), мужской', 'Американский (US), женский', 'Английский (UK)', 'Французский (FR)', 'Длина стопы, см']) assert.ok(nike.includes(t), t);
    assert.match(nike, /<button class="sz" type="button" data-sz data-eu="35.5"[^>]*>35,5<\/button>/, 'в подписи плитки запятая, как принято по-русски');
    const ad = await get(`/p/${adidasSlug}`);
    assert.match(ad, /data-eu="41 1\/3"/);
    assert.match(ad, /<button class="sz is-have" type="button" data-sz data-eu="42" data-have="1"/);
  });

  test('у неизвестного бренда универсальная таблица с пометкой, окно открывается и у него', async () => {
    const ugg = await get(`/p/${uggSlug}`);
    assert.match(ugg, /data-sizesheet/);
    assert.match(ugg, /Универсальная таблица/);
    assert.match(ugg, /у UGG размеры могут отличаться/i);
  });

  test('окно есть только у обуви: у одежды прежний блок мерок, у аксессуаров ничего', async () => {
    assert.doesNotMatch(await get(`/p/${shirtSlug}`), /data-sizesheet|data-sizeguide-open/);
    assert.doesNotMatch(await get(`/p/${capSlug}`), /data-sizesheet|data-sizeguide-open/);
  });

  test('одежда: таблица мерок, аксессуары и электроника без таблицы', async () => {
    const shirt = await get(`/p/${shirtSlug}`);
    assert.match(shirt, /<summary>Таблица размеров<\/summary>/);
    assert.match(shirt, /Грудь, см/);
    assert.doesNotMatch(await get(`/p/${capSlug}`), /Таблица размеров<\/summary>/);
  });

  test('страница «Таблицы размеров»: все бренды и одежда, ссылка из каталога', async () => {
    const page = await client(shop.base).get('/razmery');
    assert.equal(page.status, 200);
    for (const t of ['Nike и Jordan', 'adidas и Yeezy', 'New Balance', 'Универсальная таблица', 'Одежда']) assert.ok(page.text.includes(t), t);
    assert.match(page.text, /Как измерить стопу/);
    const cat = await get('/catalog');
    assert.match(cat, /<a class="sizelink" href="\/razmery">Таблица размеров<\/a>/);
    assert.match(await get('/sitemap.xml'), /\/razmery</);
  });
});
