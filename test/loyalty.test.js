'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop } = require('./helpers');
const { EXT_BASE } = require('../src/ext');
const { DEFAULT_LOYALTY: L, validateLoyalty, tierFor, effectivePct, computeDiscount, cardNumber, createLoyalty } = require('../src/loyalty');

const line = (pid, sum, oldPrice = 0) => ({ pid, sum, model: { oldPrice } });

test('уровни: порог включается, на высшем уровне следующего нет', () => {
  assert.equal(tierFor(L, 0).tier.name, 'Старт');
  assert.equal(tierFor(L, 29999).tier.name, 'Старт');
  assert.equal(tierFor(L, 30000).tier.name, 'Серебро');
  assert.equal(tierFor(L, 30000).next.name, 'Золото');
  assert.equal(tierFor(L, 42000).toNext, 58000);
  assert.equal(tierFor(L, 250000).tier.name, 'Платина');
  assert.equal(tierFor(L, 250000).next, null);
  assert.equal(tierFor(L, 250000).toNext, 0);
});

test('процент: большее из уровня и личной, при выключенной лояльности 0', () => {
  assert.equal(effectivePct(L, 30000, 0), 3);
  assert.equal(effectivePct(L, 30000, 5), 5);
  assert.equal(effectivePct(L, 100000, 3), 5);
  assert.equal(effectivePct({ ...L, enabled: false }, 1e6, 10), 0);
});

test('скидка: округление вниз, акционные строки не в счёт, электроника по настройке', () => {
  assert.deepEqual(computeDiscount([line(1, 1999)], 3, L), { discount: 59, base: 1999 });
  assert.deepEqual(computeDiscount([line(1, 5000, 6000)], 7, L), { discount: 0, base: 0 });
  assert.deepEqual(computeDiscount([line(1, 5000, 6000), line(2, 10000)], 5, L), { discount: 500, base: 10000 });
  assert.equal(computeDiscount([line(EXT_BASE + 1, 10000)], 5, L).discount, 500);
  assert.equal(computeDiscount([line(EXT_BASE + 1, 10000)], 5, { ...L, applyToElectronics: false }).discount, 0);
  assert.equal(computeDiscount([line(1, 5000, 6000)], 7, { ...L, applyToSale: true }).discount, 350);
  assert.equal(computeDiscount([line(1, 5000)], 0, L).discount, 0);
});

test('номер карты', () => {
  assert.equal(cardNumber(42), 'SH-000042');
  assert.equal(cardNumber(1234567), 'SH-1234567');
});

test('проверка настроек уровней', () => {
  const form = (from, percent, extra = {}) => ({ enabled: 'on', tierName: from.map((_, i) => `У${i}`), tierFrom: from.map(String), tierPercent: percent.map(String), ...extra });
  assert.ok(validateLoyalty(form([0, 30000, 20000], [0, 3, 5])).error, 'пороги не растут');
  assert.ok(validateLoyalty(form([100, 30000], [0, 3])).error, 'первый порог не ноль');
  assert.ok(validateLoyalty(form([0, 30000], [0, 101])).error, 'процент больше 100');
  assert.ok(validateLoyalty(form([0], [0])).error, 'меньше двух уровней');
  assert.ok(validateLoyalty({ ...form([0, 1000], [0, 3]), tierName: ['', 'Б'] }).error, 'пустое имя');
  const ok = validateLoyalty(form([0, 1000, 5000], [0, 2.5, 4], { applyToSale: 'on' }));
  assert.deepEqual(ok.value, { enabled: true, applyToSale: true, applyToElectronics: false, tiers: [{ name: 'У0', from: 0, percent: 0 }, { name: 'У1', from: 1000, percent: 2.5 }, { name: 'У2', from: 5000, percent: 4 }] });
});

test('накопленная сумма: только получено, без доставки, после скидки', async () => {
  const shop = await startShop('loyalty1');
  try {
    const { rows } = await shop.db.query("INSERT INTO webshop.customers (phone, name, personal_discount) VALUES ('79160000201', 'Аня', 10) RETURNING *");
    const cust = rows[0];
    const addOrder = (n, status, subtotal, discount, total) => shop.db.query(
      `INSERT INTO webshop.orders (number, token, customer_id, status, name, phone, delivery_code, delivery_title, delivery_kind, pay_method, subtotal, discount, total)
       VALUES ($1, $1, $2, $3, 'Аня', '79160000201', 'pickup', 'Самовывоз', 'pickup', 'cod', $4, $5, $6)`, [n, cust.id, status, subtotal, discount, total]);
    await addOrder('9001', 'delivered', 30000, 900, 29100 + 500);   // 29 100 за товары, 500 доставка не считается
    await addOrder('9002', 'delivered', 10000, 0, 10000);
    await addOrder('9003', 'paid', 99999, 0, 99999);                 // не получен
    await addOrder('9004', 'cancelled', 99999, 0, 99999);
    const loyalty = createLoyalty({ db: shop.db, settings: shop.services.settings });
    assert.equal(await loyalty.spentOf(cust.id), 39100);
    const st = await loyalty.statusOf(cust);
    assert.equal(st.cardNo, `SH-${String(cust.id).padStart(6, '0')}`);
    assert.equal(st.tier.name, 'Серебро');
    assert.equal(st.next.name, 'Золото');
    assert.equal(st.toNext, 60900);
    assert.equal(st.personal, 10);
    assert.equal(st.pct, 10);
    assert.equal(st.enabled, true);
  } finally { await shop.stop(); }
});
