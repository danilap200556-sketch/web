'use strict';
// Сезонная витрина. Сезон по умолчанию определяется по дате, в админке его можно закрепить вручную.
// Каждому сезону соответствуют: оформление (data-season в CSS), заголовок главной и правила подбора моделей.
const { hash } = require('./catalog');

const SEASONS = {
  winter: {
    title: 'Зима', accent: 'ледяной',
    hero: { eyebrow: 'Зима', title: 'Тепло, которое хочется носить', text: 'Угги, ботинки на мембране и пуховики. Подобрали пары, в которых не страшны ни снег, ни реагенты.' },
    types: { Угги: 8, Ботинки: 7, Пуховик: 7, Куртка: 5, Жилет: 3, Худи: 2, Толстовка: 2, Кроссовки: 1 },
    brands: { UGG: 4, Timberland: 4, "Arc'teryx": 4, 'Stone Island': 3, Carhartt: 2, Salomon: 2 },
    words: ['boot', 'waterproof', 'gore', 'fleece', 'puffer', 'winter', 'tex'],
  },
  spring: {
    title: 'Весна', accent: 'свежий',
    hero: { eyebrow: 'Весна', title: 'Лёгкие пары на каждый день', text: 'Светлые кроссовки и кеды, ветровки и худи. Новые расцветки сезона уже на складе.' },
    types: { Кроссовки: 5, Кеды: 5, Ветровка: 4, Худи: 2, Лонгслив: 3, Куртка: 2, Слипоны: 2 },
    brands: { 'New Balance': 3, ASICS: 3, adidas: 3, Nike: 2, On: 3, Hoka: 2, Saucony: 2 },
    words: ['samba', 'gazelle', 'cloud', 'run', 'pink', 'mint', 'cream'],
  },
  summer: {
    title: 'Лето', accent: 'солнечный',
    hero: { eyebrow: 'Лето', title: 'Сандалии, слайды и светлые кеды', text: 'Лёгкая обувь и одежда для жары: шлёпанцы, сабо, шорты и футболки.' },
    types: { Шлёпанцы: 8, Слайды: 8, Сабо: 7, Мюли: 4, Сандалии: 7, Шорты: 5, Футболка: 5, Кеды: 3, Слипоны: 3, Кепка: 3 },
    brands: { Crocs: 4, adidas: 1, Nike: 1, 'Stone Island': 1 },
    words: ['slide', 'clog', 'sandal', 'white', 'light', 'mesh'],
  },
  autumn: {
    title: 'Осень', accent: 'тёплый',
    hero: { eyebrow: 'Осень', title: 'Слои, замша и плотные подошвы', text: 'Ботинки, кроссовки на мембране, худи и куртки. Всё, что нужно для мокрого асфальта и первых холодов.' },
    types: { Ботинки: 6, Кроссовки: 2, Худи: 4, Свитшот: 4, Куртка: 4, Жилет: 3, Угги: 2, Толстовка: 3, Брюки: 1 },
    brands: { Timberland: 4, 'New Balance': 3, Carhartt: 3, "Arc'teryx": 3, Salomon: 3, ASICS: 2, 'Stone Island': 2 },
    words: ['gore', 'tex', 'waterproof', 'suede', 'boot', 'trail', 'brown', 'olive'],
  },
};

// 12, 1, 2 - зима; 3-5 - весна; 6-8 - лето; 9-11 - осень
function seasonOf(date = new Date(), tz = 'Europe/Moscow') {
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(date));
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 8) return 'summer';
  return 'autumn';
}

function currentSeason(settings, date, tz) {
  const m = settings && settings.seasonMode;
  return SEASONS[m] ? m : seasonOf(date, tz);
}

function heroFor(season, settings) {
  const base = SEASONS[season].hero;
  const o = (settings && settings.heroOverrides && settings.heroOverrides[season]) || {};
  return { eyebrow: o.eyebrow || base.eyebrow, title: o.title || base.title, text: o.text || base.text };
}

// Модели, которые лучше всего подходят сезону. Результат стабилен в течение дня: без «прыгающей» главной.
function seasonPicks(models, season, n = 8, day = '') {
  const s = SEASONS[season];
  const scored = [];
  for (const m of models) {
    if (!m.inStock || !m.cover) continue;
    let score = (s.types[m.type] || 0) + (s.brands[m.brand] || 0);
    const hay = m.search;
    for (const w of s.words) if (hay.includes(w)) score += 1;
    if (!score) continue;
    if (m.featured) score += 4;
    score += (Math.abs(hash(m.key + day)) % 100) / 100 * 2; // чуть перемешиваем равные
    scored.push([m, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  // Не больше 3 моделей одного бренда и типа подряд: чтобы не было «стены» одинаковых кроссовок
  const out = [];
  const seen = new Map();
  for (const [m] of scored) {
    const k = m.brand + '|' + m.type;
    if ((seen.get(k) || 0) >= 3) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
    out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

module.exports = { SEASONS, seasonOf, currentSeason, heroFor, seasonPicks };
