'use strict';
// Перевозчики с расчётом по API. Сейчас подключён СДЭК; Boxberry и Почта России добавляются тем же способом
// (нужен объект с полями code, title, suggestCities, points, tariff, check) и своими ключами в .env.
const { createCdek, CarrierError } = require('./cdek');

function createCarriers(cfg, { fetchImpl } = {}) {
  const c = (cfg.carriers && cfg.carriers.cdek) || {};
  const list = {};
  if (c.account && c.secret) list.cdek = createCdek({ ...c, fetchImpl: fetchImpl || fetch });
  return {
    has: (code) => Boolean(list[code]),
    get: (code) => list[code] || null,
    all: () => Object.values(list),
    parcel: (cfg.carriers && cfg.carriers.parcel) || { weightG: 1500, length: 34, width: 22, height: 14 },
  };
}

// Посылка по корзине: коробки ставятся друг на друга (высота складывается), вес суммируется.
function parcelOf(lines, p) {
  const qty = Math.max(1, lines.reduce((a, l) => a + (l.qty || 0), 0));
  return [{ weight: p.weightG * qty, length: p.length, width: p.width, height: Math.min(250, p.height * qty) }];
}

module.exports = { createCarriers, parcelOf, CarrierError };
