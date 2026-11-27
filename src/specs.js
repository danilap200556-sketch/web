'use strict';
// Характеристики электроники, которые покупатель выбирает в фильтрах: линейка (iPhone, iPad, MacBook...), модель, память, SIM, связь,
// чип, диагональ, размер корпуса, цвет. Отдельных полей у товаров партнёров нет (у них только название), поэтому характеристики
// достаются из названия по правилам ниже. Что не удалось определить, просто не заполняется: ложное значение хуже пустого,
// потому что покупатель отфильтрует им не те товары.
//
// parseSpecs({ title, type }) -> { family, line, storage, ram, sim, net, chip, screen, case, color } (только найденные поля).

const STORAGE = new Set([16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);        // встроенная память, ГБ
const RAMS = new Set([2, 3, 4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128]); // оперативная память, ГБ

// Фильтры по характеристикам. param - имя в адресе (?mem=256+ГБ), crit - поле условий каталога, field - поле specs у модели.
// sort 'num' - по числу в значении (128 ГБ, 1 ТБ, 11″), иначе по числу товаров. parent - от какого фильтра зависит (при смене родителя
// выбранное в зависимых сбрасывается: после выбора iPad память iPhone уже не нужна).
const SPEC_FACETS = [
  { param: 'fam', crit: 'fams', field: 'family', title: 'Линейка' },
  { param: 'model', crit: 'models', field: 'line', title: 'Модель' },
  { param: 'mem', crit: 'mems', field: 'storage', title: 'Память', sort: 'num' },
  { param: 'ram', crit: 'rams', field: 'ram', title: 'Оперативная память', sort: 'num' },
  { param: 'sim', crit: 'sims', field: 'sim', title: 'SIM' },
  { param: 'net', crit: 'nets', field: 'net', title: 'Связь' },
  { param: 'chip', crit: 'chips', field: 'chip', title: 'Чип' },
  { param: 'screen', crit: 'screens', field: 'screen', title: 'Диагональ', sort: 'num' },
  { param: 'case', crit: 'cases', field: 'case', title: 'Размер корпуса', sort: 'num' },
  { param: 'color', crit: 'colors', field: 'color', title: 'Цвет' },
];
const CHILD_PARAMS = SPEC_FACETS.filter((f) => f.param !== 'fam').map((f) => f.param);   // зависят от линейки
const SPEC_PARAMS = SPEC_FACETS.map((f) => f.param);

// «128 ГБ» -> 128, «1 ТБ» -> 1024, «11″» -> 11, «42 мм» -> 42
const numOf = (v) => { const n = parseFloat(String(v).replace(',', '.')); return /ТБ/.test(v) ? n * 1024 : n; };
const byStorage = (a, b) => numOf(a) - numOf(b);

const clean = (s) => ` ${String(s ?? '').replace(/[«»"“”'`]/g, ' ').replace(/_+/g, ' ').replace(/\s+/g, ' ')} `;
const toGb = (n, unit) => Math.round(parseFloat(String(n).replace(',', '.')) * (/^(?:tb|тб)/.test(unit || '') ? 1024 : 1));
const fmtGb = (n) => (n >= 1024 ? `${n / 1024} ТБ` : `${n} ГБ`);
const cap = (w) => ({ ultra: 'Ultra', plus: 'Plus', '+': 'Plus', fe: 'FE', edge: 'Edge', classic: 'Classic', pro: 'Pro', lite: 'Lite', max: 'Max', mini: 'mini', air: 'Air' })[w] || w;

// ---------- Линейка и модель ----------
// Возвращает { family, line, kind } или null. kind: phone, tablet, watch, mac, other - от него зависит, какие характеристики искать.
function detectFamily(s) {
  let m;
  // Apple
  if (/(?<![a-z])(?:iphone|айфон)(?![a-z])/.test(s)) {
    const rest = s.slice(s.search(/iphone|айфон/) + 6, s.search(/iphone|айфон/) + 50);
    const tok = (rest.match(/[a-zа-я0-9]+/g) || []).slice(0, 6);
    const word = (w) => tok.includes(w);
    let gen = '';
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (/^\d{1,2}e?$/.test(t) && parseInt(t, 10) >= 1 && parseInt(t, 10) <= 30) { gen = t; if (!/e$/.test(t) && tok[i + 1] === 'e') gen += 'e'; break; }
      if (/^\d{3,}/.test(t) || /(gb|tb|гб|тб)$/.test(t)) break;
    }
    let line;
    if (word('se')) line = 'iPhone SE';
    else if (word('air')) line = 'iPhone Air';
    else if (gen) line = `iPhone ${gen}${word('pro') && word('max') ? ' Pro Max' : word('pro') ? ' Pro' : word('plus') ? ' Plus' : word('mini') ? ' mini' : ''}`;
    return { family: 'iPhone', line, kind: 'phone' };
  }
  if (/(?<![a-z])ipad(?![a-z])/.test(s)) {
    const v = /ipad\s*(air|pro|mini)(?![a-z])/.exec(s);
    return { family: 'iPad', line: v ? `iPad ${cap(v[1])}` : 'iPad', kind: 'tablet' };
  }
  if ((m = /macbook\s*(air|pro)?(?![a-z])/.exec(s))) return { family: 'MacBook', line: m[1] ? `MacBook ${cap(m[1])}` : 'MacBook', kind: 'mac' };
  if (/(?<![a-z])imac(?![a-z])/.test(s)) return { family: 'iMac', kind: 'mac' };
  if (/mac\s*mini/.test(s)) return { family: 'Mac mini', kind: 'mac' };
  if (/mac\s*studio/.test(s)) return { family: 'Mac Studio', kind: 'mac' };
  if (/(?<![a-z])mac\s*pro(?![a-z])/.test(s)) return { family: 'Mac Pro', kind: 'mac' };
  if (/apple\s*watch/.test(s) || (!/galaxy|pixel/.test(s) && /(?<![a-z])watch\s*(?:series|ultra|se)(?![a-z])/.test(s))) {
    let line;
    if ((m = /ultra\s*(\d)(?![\d])/.exec(s))) line = `Ultra ${m[1]}`;
    else if (/ultra/.test(s)) line = 'Ultra';
    else if ((m = /series\s*(\d{1,2})(?![\d])|(?<![a-z0-9])s(\d{1,2})(?![a-z0-9])/.exec(s))) line = `Series ${m[1] || m[2]}`;
    else if (/(?<![a-z])se(?![a-z])/.test(s)) line = 'SE';
    return { family: 'Apple Watch', line, kind: 'watch' };
  }
  if (/airpods/.test(s)) {
    const v = /airpods\s*(max|pro\s*\d?|\d)/.exec(s);
    const line = v ? `AirPods ${v[1].replace(/\s+/g, ' ').trim().replace(/^max$/, 'Max').replace(/^pro/, 'Pro')}` : 'AirPods';
    return { family: 'AirPods', line, kind: 'other' };
  }
  if (/airtag/.test(s)) return { family: 'AirTag', kind: 'other' };
  if (/homepod/.test(s)) return { family: 'HomePod', kind: 'other' };
  if (/apple\s*tv/.test(s)) return { family: 'Apple TV', kind: 'other' };
  if (/vision\s*pro/.test(s)) return { family: 'Vision Pro', kind: 'other' };
  // Samsung Galaxy
  if (/galaxy/.test(s)) {
    if ((m = /galaxy\s*tab\s*([sa]?\d{1,2}[a-z]?)?\s*(ultra|plus|\+|fe|lite)?(?![a-z])/.exec(s))) return { family: 'Galaxy Tab', line: `Galaxy Tab${m[1] ? ' ' + m[1].toUpperCase() : ''}${m[2] ? ' ' + cap(m[2]) : ''}`, kind: 'tablet' };
    if ((m = /galaxy\s*watch\s*(fe|ultra|\d{1,2})?(?![a-z0-9])\s*(classic|pro|ultra|fe)?(?![a-z])/.exec(s))) {
      const a = m[1] ? (/^\d/.test(m[1]) ? m[1] : cap(m[1])) : '';
      return { family: 'Galaxy Watch', line: `Galaxy Watch${a ? ' ' + a : ''}${m[2] ? ' ' + cap(m[2]) : ''}`, kind: 'watch' };
    }
    if ((m = /galaxy\s*buds\s*(\d{1,2})?\s*(pro|fe|live|core|plus)?(?![a-z])/.exec(s))) return { family: 'Galaxy Buds', line: `Galaxy Buds${m[1] || ''}${m[2] ? ' ' + cap(m[2]) : ''}`, kind: 'other' };
    if (/galaxy\s*ring/.test(s)) return { family: 'Galaxy Ring', kind: 'other' };
    if ((m = /galaxy\s*book\s*(\d{1,2})?\s*(pro|ultra|360|edge)?(?![a-z])/.exec(s))) return { family: 'Galaxy Book', line: `Galaxy Book${m[1] || ''}${m[2] ? ' ' + cap(m[2]) : ''}`, kind: 'mac' };
    if ((m = /galaxy\s*z\s*(fold|flip)\s*(\d{1,2})?\s*(fe)?(?![a-z])/.exec(s))) return { family: 'Galaxy Z', line: `Galaxy Z ${cap(m[1])}${m[2] || ''}${m[3] ? ' FE' : ''}`.replace(/^Galaxy Z fold/i, 'Galaxy Z Fold').replace(/^Galaxy Z flip/i, 'Galaxy Z Flip'), kind: 'phone' };
    if ((m = /galaxy\s*s(\d{1,2})(?![a-z0-9])\s*(ultra|plus|\+|fe|edge)?(?![a-z])/.exec(s))) return { family: 'Galaxy S', line: `Galaxy S${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}`, kind: 'phone' };
    if ((m = /galaxy\s*a(\d{1,2})(?![a-z0-9])/.exec(s))) return { family: 'Galaxy A', line: `Galaxy A${m[1]}`, kind: 'phone' };
    if ((m = /galaxy\s*m(\d{1,2})(?![a-z0-9])/.exec(s))) return { family: 'Galaxy M', line: `Galaxy M${m[1]}`, kind: 'phone' };
  }
  // Google Pixel
  if (/pixel\s*watch/.test(s)) return { family: 'Pixel Watch', kind: 'watch' };
  if (/pixel\s*buds/.test(s)) return { family: 'Pixel Buds', kind: 'other' };
  if ((m = /pixel\s*(\d{1,2})\s*(a|pro\s*xl|pro\s*fold|pro|xl)?(?![a-z])/.exec(s))) {
    const v = m[2] ? m[2].replace(/\s+/g, ' ') : '';
    const t = !v ? '' : v === 'a' ? 'a' : ` ${v.split(' ').map((w) => (w === 'xl' ? 'XL' : cap(w))).join(' ')}`;
    return { family: 'Pixel', line: `Pixel ${m[1]}${t}`, kind: 'phone' };
  }
  // Xiaomi
  if (/redmi\s*note/.test(s)) return { family: 'Redmi Note', kind: 'phone' };
  if (/(?<![a-z])redmi(?![a-z])/.test(s) && !/redmi\s*(?:pad|buds|watch|band)/.test(s)) return { family: 'Redmi', kind: 'phone' };
  if (/(?<![a-z])poco(?![a-z])/.test(s)) return { family: 'POCO', kind: 'phone' };
  if ((m = /(?:xiaomi|redmi|mi)\s*(pad|watch|band|buds)(?![a-z])/.exec(s))) return { family: `Xiaomi ${m[1] === 'band' ? 'Smart Band' : cap(m[1]).replace('pad', 'Pad').replace('watch', 'Watch').replace('buds', 'Buds')}`, kind: m[1] === 'pad' ? 'tablet' : m[1] === 'watch' || m[1] === 'band' ? 'watch' : 'other' };
  if (/xiaomi\s*\d{2}/.test(s)) return { family: 'Xiaomi', kind: 'phone' };
  // Dyson
  if (/airwrap/.test(s)) return { family: 'Airwrap', kind: 'other' };
  if (/supersonic/.test(s)) return { family: 'Supersonic', kind: 'other' };
  if (/airstrait/.test(s)) return { family: 'Airstrait', kind: 'other' };
  if (/corrale/.test(s)) return { family: 'Corrale', kind: 'other' };
  if (/dyson/.test(s)) {   // по коду модели: HS07 - Corrale, остальные HS и «Complete Long» - Airwrap, HD - Supersonic, HT - Airstrait
    if (/(?<![a-z])hs07(?![a-z0-9])/.test(s)) return { family: 'Corrale', kind: 'other' };
    if (/(?<![a-z])hs0\d(?![a-z0-9])|complete\s*long/.test(s)) return { family: 'Airwrap', kind: 'other' };
    if (/(?<![a-z])hd\d{2}(?![a-z0-9])/.test(s)) return { family: 'Supersonic', kind: 'other' };
    if (/(?<![a-z])ht\d{2}(?![a-z0-9])/.test(s)) return { family: 'Airstrait', kind: 'other' };
  }
  if (/dyson/.test(s) && /(?:пылесос|(?<![a-z])v\d{1,2}(?![a-z0-9])|gen\s*5|vacuum|cyclone|outsize|micro)/.test(s)) return { family: 'Пылесосы', kind: 'other' };
  if (/dyson/.test(s) && /(?:очистител|purifier|увлажн|humidif)/.test(s)) return { family: 'Очистители воздуха', kind: 'other' };
  // DJI
  if ((m = /osmo\s*(pocket|action|360|nano|mobile)(?![a-z])/.exec(s))) return { family: `Osmo ${m[1] === '360' ? '360' : cap(m[1]).replace('pocket', 'Pocket').replace('action', 'Action').replace('nano', 'Nano').replace('mobile', 'Mobile')}`, kind: 'other' };
  return null;
}

// ---------- Память ----------
// Возвращает { storage, ram, rest }: rest - название без разобранных мест (чтобы «256» не приняли за диагональ).
function memory(s, kind, family = '') {
  let ram = 0;
  let storage = 0;
  let out = s;
  // 12/256GB, 8/128 ГБ, 16/1TB: оперативная / встроенная
  out = out.replace(/(?<![\d.,])(\d{1,3})\s*(?:gb|гб)?\s*\/\s*(\d{1,4}(?:[.,]\d)?)\s*(gb|гб|tb|тб)?(?![\d])/, (m, a, b, u) => {
    const r = Number(a);
    const st = toGb(b, u || (Number(String(b).replace(',', '.')) <= 4 ? 'tb' : 'gb'));
    if (RAMS.has(r) && STORAGE.has(st) && st > r) { ram = r; storage = st; return ' '; }
    return m;
  });
  // «Mac ... 16 512GB», «... 16 1TB»: оперативная без единиц перед встроенной (только у Mac: у iPhone 16 - это поколение)
  if (!storage && (kind === 'mac' || /^(?:Galaxy|Pixel|Xiaomi|Redmi|POCO)/.test(family))) {
    out = out.replace(/(?<![\d.,m])(\d{1,3})\s+(\d+(?:[.,]\d)?)\s*(tb|тб|gb|гб)(?![a-zа-я\d])/, (m, a, b, u) => {
      const r = Number(a);
      const st = toGb(b, u);
      if (RAMS.has(r) && STORAGE.has(st)) { ram = r; storage = st; return ' '; }
      return m;
    });
  }
  // Явные значения с единицами: «16GB 256GB SSD», «128 ГБ», «1 ТБ»
  const vals = [];
  out = out.replace(/(?<![\d.,])(\d{1,4}(?:[.,]\d)?)\s*(gb|гб|tb|тб)(?![a-zа-я])/g, (m, n, u) => { vals.push(toGb(n, u)); return ' '; });
  out = out.replace(/(?<![\d.,a-z])([1-4])\s*(t|т)(?![a-zа-я])/, (m, n) => { vals.push(toGb(n, 'tb')); return ' '; });   // «1t» = 1 ТБ
  if (!storage) {
    if (vals.length >= 2) {
      const sorted = vals.slice().sort((a, b) => a - b);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      if (RAMS.has(lo) && STORAGE.has(hi) && hi > lo) { ram = ram || lo; storage = hi; }
      else storage = vals.find((v) => STORAGE.has(v)) || 0;
    } else if (vals.length === 1) {
      const v = vals[0];
      if (kind === 'mac' && v < 64 && RAMS.has(v)) ram = ram || v;
      else if (STORAGE.has(v)) storage = v;
    }
  }
  return { storage: storage ? fmtGb(storage) : '', ram: ram ? fmtGb(ram) : '', rest: out };
}

// ---------- Остальные характеристики ----------
function simOf(s) {
  if (/(?<![a-zа-я])(?:sim|сим)\s*[+\/&-]?\s*e-?sim|sim\s*(?:и|and)\s*e-?sim/.test(s)) return 'SIM + eSIM';
  if (/dual\s*-?\s*sim|(?<![a-z0-9])2\s*-?\s*sim|две\s*sim/.test(s)) return 'Dual SIM';
  if (/e-?sim/.test(s)) return 'eSIM';
  if (/nano\s*-?\s*sim|(?<![a-zа-я])sim(?![a-zа-я])/.test(s)) return 'SIM';
  return '';
}

function netOf(s, kind) {
  const cellular = /cellular|(?<![a-z])(?:lte|5g|4g)(?![a-z])|сотов/.test(s);
  if (kind === 'watch') return cellular ? 'GPS + Cellular' : /gps|wi-?\s*fi|вай-?фай/.test(s) ? 'GPS' : '';
  if (kind === 'tablet') return cellular ? 'Wi-Fi + Cellular' : /wi-?\s*fi|вай-?фай/.test(s) ? 'Wi-Fi' : '';
  return '';
}

const SCREENS = { iPad: [8.3, 10.2, 10.9, 11, 12.9, 13], MacBook: [13, 13.3, 13.6, 14, 15, 15.3, 16], iMac: [24] };
function screenOf(rest, family) {
  const allowed = SCREENS[family];
  if (!allowed) return '';
  const re = /(?<![\d.,a-z])(\d{1,2}(?:[.,]\d)?)(?![\d.,a-z])/g;
  let m;
  while ((m = re.exec(rest))) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (allowed.includes(n)) return `${String(m[1]).replace(',', '.')}″`;
  }
  return '';
}

function chipOf(rest) {
  const m = /(?<![a-z0-9])m([1-9])(?![a-z0-9])(?:\s*(pro|max|ultra))?(?![a-z])/.exec(rest);
  return m ? `M${m[1]}${m[2] ? ' ' + cap(m[2]) : ''}` : '';
}

const caseOf = (s) => { const m = /(?<![\d.,])(\d{2})\s*(?:mm|мм)(?![a-zа-я])/.exec(s); return m ? `${m[1]} мм` : ''; };

// Цвет по первому названному в тексте (у часов сначала корпус, потом ремешок). Слова латиницей и по-русски.
const COLORS = [
  ['Голубой', /(?<![a-z])(?:sky|ice|light|baby|pale)[\s-]*blue(?![a-z])|голуб/],
  ['Бордовый', /(?<![a-z])(?:burgundy|maroon|wine)(?![a-z])|бордов|винн/],
  ['Натуральный титан', /(?<![a-z])(?:natural|desert)(?:[\s-]*titanium)?(?![a-z])|натуральн/],
  ['Чёрный', /(?<![a-z])(?:black|jet|obsidian|onyx|midnight)(?![a-z])|ч[её]рн/],
  ['Серый', /(?<![a-z])(?:gr[ae]y|graphite)(?![a-z])|сер(?:ый|ая|ое|ого)(?![а-я])|графит/],
  ['Белый', /(?<![a-z])(?:white|snow|pearl)(?![a-z])|star[\s-]*light|бел(?:ый|ая|ое|ого)(?![а-я])/],
  ['Серебристый', /(?<![a-z])silver(?![a-z])|серебр/],
  ['Золотой', /(?<![a-z])(?:gold|champagne)(?![a-z])|золот/],
  ['Синий', /(?<![a-z])(?:blue|navy|indigo|ultramarine)(?![a-z])|син(?:ий|яя|ее|его)(?![а-я])|ультрамарин/],
  ['Зелёный', /(?<![a-z])(?:green|olive|sage|mint)(?![a-z])|зел[её]н/],
  ['Бирюзовый', /(?<![a-z])(?:teal|turquoise|aquamarine|cyan)(?![a-z])|бирюз/],
  ['Красный', /(?<![a-z])(?:red|scarlet)(?![a-z])|красн/],
  ['Розовый', /(?<![a-z])(?:pink|rose|blush)(?![a-z])|розов/],
  ['Фиолетовый', /(?<![a-z])(?:purple|violet|lavender|lilac|periwinkle)(?![a-z])|фиолет|сиренев/],
  ['Оранжевый', /(?<![a-z])orange(?![a-z])|оранж/],
  ['Жёлтый', /(?<![a-z])(?:yellow|lemon)(?![a-z])|ж[её]лт/],
  ['Бежевый', /(?<![a-z])(?:beige|sand|cream)(?![a-z])|бежев|песочн/],
  ['Коричневый', /(?<![a-z])(?:brown|umber|mocha)(?![a-z])|коричнев/],
];
function colorOf(s) {
  let best = null;
  for (const [label, re] of COLORS) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.index)) best = { label, index: m.index };
  }
  return best ? best.label : '';
}

// ---------- Всё вместе ----------
function parseSpecs({ title, type = '' } = {}) {
  const s = clean(title).toLowerCase();
  if (!s.trim()) return {};
  const out = {};
  const put = (k, v) => { if (v) out[k] = v; };
  const accessory = type === 'Аксессуары';       // чехол для iPhone - не iPhone: у аксессуаров только память и цвет
  const fam = accessory ? null : detectFamily(s);
  const kind = fam ? fam.kind : 'other';
  if (fam) { put('family', fam.family); put('line', fam.line); }
  const mem = memory(s, kind, fam ? fam.family : '');
  put('storage', mem.storage);
  put('ram', mem.ram);
  if (!accessory) {
    put('sim', kind === 'watch' ? '' : simOf(s));
    put('net', netOf(s, kind));
    if (fam && (fam.family === 'iPad' || kind === 'mac') && fam.family !== 'Galaxy Book') put('chip', chipOf(mem.rest));
    if (fam) put('screen', screenOf(mem.rest, fam.family));
    if (kind === 'watch') put('case', caseOf(s));
  }
  put('color', colorOf(s));
  return out;
}

module.exports = { parseSpecs, SPEC_FACETS, SPEC_PARAMS, CHILD_PARAMS, byStorage, numOf };
