'use strict';
// Лояльность: уровни по накопленной сумме полученных заказов и скидка при оформлении.
// Уровни и правила лежат в настройках (webshop.settings, ключ loyalty) и правятся в админке.
const { isExtPid } = require('./ext');

const DEFAULT_LOYALTY = {
  enabled: true,
  applyToSale: false,        // скидка уровня не суммируется с акционной ценой
  applyToElectronics: true,  // на товары партнёра скидка действует
  tiers: [
    { name: 'Старт', from: 0, percent: 0 },
    { name: 'Серебро', from: 30000, percent: 3 },
    { name: 'Золото', from: 100000, percent: 5 },
    { name: 'Платина', from: 250000, percent: 7 },
  ],
};

const arr = (v) => (v === undefined ? [] : [].concat(v));
const num = (v) => Number(String(v ?? '').replace(',', '.').trim());

// Проверка того, что владелец вписал в админке («Лояльность»). Возвращает { error } или { value }.
function validateLoyalty(b) {
  const names = arr(b.tierName).map((x) => String(x).replace(/\s+/g, ' ').trim());
  const froms = arr(b.tierFrom).map(num);
  const percents = arr(b.tierPercent).map(num);
  const n = names.length;
  if (n < 2 || n > 8) return { error: 'Нужно от 2 до 8 уровней' };
  if (froms.length !== n || percents.length !== n) return { error: 'У каждого уровня должны быть название, порог и процент' };
  const tiers = [];
  for (let i = 0; i < n; i++) {
    if (names[i].length < 1 || names[i].length > 30) return { error: `Уровень ${i + 1}: название от 1 до 30 символов` };
    if (!Number.isFinite(froms[i]) || froms[i] < 0 || froms[i] > 100_000_000) return { error: `Уровень «${names[i]}»: порог указывается в рублях, числом` };
    if (!Number.isFinite(percents[i]) || percents[i] < 0 || percents[i] > 100) return { error: `Уровень «${names[i]}»: процент от 0 до 100` };
    tiers.push({ name: names[i], from: Math.round(froms[i]), percent: Math.round(percents[i] * 100) / 100 });
  }
  if (tiers[0].from !== 0) return { error: 'Первый уровень начинается с 0 ₽' };
  for (let i = 1; i < n; i++) if (tiers[i].from <= tiers[i - 1].from) return { error: `Порог уровня «${tiers[i].name}» должен быть больше порога предыдущего уровня` };
  return { value: { enabled: b.enabled === 'on', applyToSale: b.applyToSale === 'on', applyToElectronics: b.applyToElectronics === 'on', tiers } };
}

// Уровень по накопленной сумме: tier - текущий, next - следующий (null на высшем), toNext - сколько осталось до него.
function tierFor(loyalty, spent) {
  const tiers = [...loyalty.tiers].sort((a, b) => a.from - b.from);
  let index = 0;
  tiers.forEach((t, i) => { if (spent >= t.from) index = i; });
  const next = tiers[index + 1] || null;
  return { tier: tiers[index], index, next, toNext: next ? Math.max(0, next.from - spent) : 0 };
}

// Процент скидки: большее из уровня и личной скидки (не суммируются). Выключена лояльность - скидки нет ни у кого.
function effectivePct(loyalty, spent, personal) {
  if (!loyalty.enabled) return 0;
  return Math.max(tierFor(loyalty, spent).tier.percent, Number(personal) || 0);
}

// Скидка с позиций заказа { pid, sum, model: { oldPrice } }: считается только с позиций по обычной цене, вниз до рубля.
function computeDiscount(lines, pct, loyalty) {
  let base = 0;
  for (const l of lines) {
    if (l.model && l.model.oldPrice > 0 && !loyalty.applyToSale) continue;
    if (isExtPid(l.pid) && !loyalty.applyToElectronics) continue;
    base += l.sum;
  }
  return { discount: pct > 0 ? Math.floor(Math.round(base * pct * 100) / 10000) : 0, base };
}

const cardNumber = (id) => `SH-${String(id).padStart(6, '0')}`;

function createLoyalty({ db, settings }) {
  // Накопленная сумма: товары (без доставки, после скидки) по заказам клиента со статусом «Получен». Считается на лету,
  // поэтому отмена или возврат сами понижают уровень.
  async function spentOf(customerId) {
    const { rows } = await db.query(
      "SELECT COALESCE(SUM(subtotal - discount), 0) AS s FROM webshop.orders WHERE customer_id = $1 AND status = 'delivered'", [customerId]);
    return Number(rows[0].s);
  }
  async function statusOf(customer) {
    const rules = (await settings.get()).loyalty;
    const spent = await spentOf(customer.id);
    const t = tierFor(rules, spent);
    const personal = Number(customer.personal_discount) || 0;
    return { cardNo: cardNumber(customer.id), spent, tier: t.tier, next: t.next, toNext: t.toNext, personal, pct: effectivePct(rules, spent, personal), enabled: rules.enabled };
  }
  return { spentOf, statusOf };
}

module.exports = { DEFAULT_LOYALTY, validateLoyalty, tierFor, effectivePct, computeDiscount, cardNumber, createLoyalty };
