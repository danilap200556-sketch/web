'use strict';
// Разбор товара из базы склада на "модель" для витрины.
//
// В складе каждый размер - отдельный товар: артикул `DD1391-100_42.5`, название без размера
// «Кроссовки Nike Dunk Low «Medium Olive»». Сайт склеивает размеры одной модели в одну карточку.
const { slugify } = require('./util');

// ---- Тип товара (первое слово названия) -> отдел ----
const DEPARTMENTS = {
  shoes: { slug: 'obuv', title: 'Обувь' },
  clothes: { slug: 'odezhda', title: 'Одежда' },
  accessories: { slug: 'aksessuary', title: 'Аксессуары' },
  electronics: { slug: 'elektronika', title: 'Электроника' },
};

const TYPE_TO_DEPT = {
  кроссовки: 'shoes', кеды: 'shoes', ботинки: 'shoes', шлёпанцы: 'shoes', шлепанцы: 'shoes', слипоны: 'shoes',
  мюли: 'shoes', угги: 'shoes', сабо: 'shoes', бутсы: 'shoes', тапочки: 'shoes', слайды: 'shoes', мокасины: 'shoes',
  слиперы: 'shoes', сандалии: 'shoes', лоферы: 'shoes', полуботинки: 'shoes', сапоги: 'shoes', туфли: 'shoes',
  свитшот: 'clothes', худи: 'clothes', футболка: 'clothes', куртка: 'clothes', жилет: 'clothes', брюки: 'clothes',
  шорты: 'clothes', лонгслив: 'clothes', толстовка: 'clothes', пуховик: 'clothes', спортивная: 'clothes',
  джинсы: 'clothes', рубашка: 'clothes', поло: 'clothes', ветровка: 'clothes', бомбер: 'clothes', костюм: 'clothes',
  сумка: 'accessories', рюкзак: 'accessories', пауч: 'accessories', косметичка: 'accessories', кепка: 'accessories',
  зонт: 'accessories', браслет: 'accessories', колье: 'accessories', шапка: 'accessories', шарф: 'accessories',
  носки: 'accessories', ремень: 'accessories', коллекционная: 'accessories', кошелёк: 'accessories', очки: 'accessories',
  наушники: 'electronics', колонка: 'electronics', часы: 'electronics', смартфон: 'electronics', телефон: 'electronics',
  планшет: 'electronics', ноутбук: 'electronics', пылесос: 'electronics', камера: 'electronics', приставка: 'electronics',
};

// Каноническое название типа (с заглавной) для витрины
const TYPE_TITLE = { шлепанцы: 'Шлёпанцы', спортивная: 'Спортивная одежда', коллекционная: 'Коллекционные фигурки' };

// Бренды: длинные раньше коротких. Ключ - как пишется в названии (регистр не важен), значение - как показывать.
const BRANDS = [
  'New Balance', 'Stone Island', 'Fear of God', 'Polo Ralph Lauren', 'Onitsuka Tiger', 'Miu Miu', 'Mark Jacobs',
  "Arc'teryx", 'Air Jordan', 'Jordan', 'Nike', 'adidas', 'ASICS', 'Puma', 'Vans', 'UGG', 'Timberland', 'Carhartt',
  'Longchamp', 'Crocs', 'Stüssy', 'Dior', 'Xiaomi', 'Coach', 'Mizuno', 'Hoka', 'Salomon', 'Premiata', 'Ocai',
  'Messika', 'Converse', 'Reebok', 'Saucony', 'Dr. Martens', 'Apple', 'Samsung', 'Sony', 'JBL', 'Dyson', 'Garmin',
  'Marshall', 'Bose', 'DC', 'On',
];
const BRAND_CANON = new Map(BRANDS.map((b) => [b.toLowerCase(), b]));
// «Air Jordan» и «Jordan» - один бренд
BRAND_CANON.set('air jordan', 'Jordan');
const BRAND_RE = new RegExp(
  '^(' + [...BRAND_CANON.keys()].sort((a, b) => b.length - a.length).map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
const ELECTRONICS_BRANDS = new Set(['Xiaomi', 'Apple', 'Samsung', 'Sony', 'JBL', 'Dyson', 'Garmin', 'Marshall', 'Bose']);

// ---- Размер из артикула ----
// Размер - в начале «хвоста» после последнего «_», и дальше не продолжается буквой или цифрой: `ABC_SALE` - не размер «S».
// То же правило в приложении «Склад» (src/siteprices.cpp, SitePrices::modelKey): ключ модели там и тут должен совпадать.
const SIZE_RE = /^(\d{2}(?:[.,]\d)?|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|OS|ONE\s*SIZE|UNI)(?![A-Za-z0-9А-Яа-яЁё])(.*)$/i;

function splitSku(sku) {
  const s = String(sku || '').trim();
  const i = s.lastIndexOf('_');
  if (i <= 0 || i === s.length - 1) return { key: s, size: '', note: '' };
  const tail = s.slice(i + 1).trim();
  const m = SIZE_RE.exec(tail);
  if (!m) return { key: s, size: '', note: '' };
  let size = m[1].replace(',', '.').toUpperCase();
  if (/^ONE\s*SIZE$|^OS$|^UNI$/.test(size)) size = 'ONE SIZE';
  const rest = m[2].trim();
  let note = '';
  if (rest) {
    if (/б\s*\/\s*к/i.test(rest)) note = 'без коробки';
    else if (/1\s*кроссов/i.test(rest)) note = 'один кроссовок';
    else {
      const w = /\(([^)]+)\)/.exec(rest);
      note = w ? w[1].trim() : rest.replace(/[()]/g, '').trim();
    }
  }
  return { key: s.slice(0, i), size, note };
}

// Для сортировки размеров: числа по возрастанию, буквенные по ряду, остальное в конце
const LETTER_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'ONE SIZE'];
function sizeOrder(label) {
  const n = parseFloat(label);
  if (Number.isFinite(n)) return n;
  const i = LETTER_ORDER.indexOf(label);
  return 1000 + (i < 0 ? 99 : i);
}

// ---- Название ----
function parseName(name, vendor = '') {
  let rest = String(name || '').replace(/\s+/g, ' ').trim();
  let type = '';
  const first = rest.split(' ')[0] || '';
  const fl = first.toLowerCase();
  if (TYPE_TO_DEPT[fl]) {
    type = TYPE_TITLE[fl] || first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    rest = rest.slice(first.length).trim();
    // «Спортивная куртка», «Коллекционная фигурка»: тип из двух слов
    if (fl === 'спортивная' || fl === 'коллекционная') {
      const sec = rest.split(' ')[0] || '';
      if (sec) { type = `${first} ${sec.toLowerCase()}`; rest = rest.slice(sec.length).trim(); }
    }
  }
  let brand = '';
  const bm = BRAND_RE.exec(rest);
  if (bm) {
    brand = BRAND_CANON.get(bm[1].toLowerCase());
    if (brand === 'Jordan' && /^air jordan/i.test(rest)) { /* оставляем «Air Jordan 1» в названии модели */ } else rest = rest.slice(bm[0].length).trim();
  } else if (vendor) {
    brand = vendor;
  }
  let colorway = '';
  const cm = /«([^»]+)»/.exec(rest);
  if (cm) {
    colorway = cm[1].trim();
    rest = (rest.slice(0, cm.index) + rest.slice(cm.index + cm[0].length)).replace(/\s+/g, ' ').trim();
  }
  return { type, brand, model: rest, colorway };
}

function deptOf(type, brand) {
  const d = TYPE_TO_DEPT[String(type).split(' ')[0].toLowerCase()];
  if (d) return d;
  if (ELECTRONICS_BRANDS.has(brand)) return 'electronics';
  return 'accessories';
}

// Цена модели на сайте. Если в приложении «Склад» (вкладка «Цены сайта») задана цена сайта - берётся она и действует на все
// размеры, иначе цена склада (products.price) у каждого размера. Скидка действует с `from` по `to` включительно (даты
// YYYY-MM-DD в часовом поясе магазина; пусто - без границы). Цена со скидкой не меньше нуля и меньше обычной, иначе её нет.
function sitePrice(sp, today) {
  if (!sp || !(sp.price > 0)) return null;
  const onSale = sp.salePrice > 0 && sp.salePrice < sp.price && (!sp.from || today >= sp.from) && (!sp.to || today <= sp.to);
  return {
    price: onSale ? sp.salePrice : sp.price,
    oldPrice: onSale ? sp.price : 0,
    discount: onSale ? Math.max(1, Math.min(99, Math.round((1 - sp.salePrice / sp.price) * 100))) : 0,
    saleTo: onSale ? sp.to || '' : '',
  };
}

// Из строк товаров склада (все размеры) собирает модели.
// rows: { id, sku, name, description, price, vendor, created_at, qty, photos: [photoId...] }
// opts.sitePrices: Map(ключ модели -> { price, salePrice, from, to }), opts.today: 'YYYY-MM-DD'
function buildModels(rows, opts = {}) {
  const reserved = opts.reserved || new Map(); // product_id -> зарезервировано
  const sitePrices = opts.sitePrices || new Map();
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const groups = new Map();
  for (const r of rows) {
    const { key, size, note } = splitSku(r.sku);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push({ ...r, size, note });
  }
  const models = [];
  for (const [key, items] of groups) {
    const named = items.find((i) => i.name && i.name.trim() && i.name.trim() !== i.sku.trim());
    if (!named) continue; // у товара нет названия (в названии стоит артикул) - на витрину не выводим
    const p = parseName(named.name, named.vendor);
    const dept = deptOf(p.type, p.brand);
    const sizes = items
      .map((i) => {
        const avail = Math.max(0, (i.qty || 0) - (reserved.get(i.id) || 0));
        const label = i.size ? (i.note ? `${i.size} · ${i.note}` : i.size) : 'Один размер';
        return { id: i.id, sku: i.sku, size: i.size, note: i.note, label, qty: avail, price: Number(i.price) || 0, order: sizeOrder(i.size) };
      })
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'ru'));
    const sp = sitePrice(sitePrices.get(key), today);
    if (sp) for (const s of sizes) s.price = sp.price; // цена сайта - одна на модель, на все размеры
    // Фото лежат у каждого размера отдельно - берём набор того размера, где их больше
    let photoOwner = items[0];
    for (const i of items) if ((i.photos || []).length > (photoOwner.photos || []).length) photoOwner = i;
    const photos = photoOwner.photos || [];
    const inStock = sizes.filter((s) => s.qty > 0);
    const priced = (inStock.length ? inStock : sizes).map((s) => s.price).filter((v) => v > 0);
    const price = priced.length ? Math.min(...priced) : 0;
    const priceMax = priced.length ? Math.max(...priced) : 0;
    const created = items.map((i) => new Date(i.created_at).getTime()).filter(Number.isFinite);
    const desc = (items.find((i) => i.description && i.description.trim()) || {}).description || '';
    const title = [p.brand, p.model].filter(Boolean).join(' ') || named.name;
    models.push({
      key,
      slug: slugify(key),
      type: p.type,
      brand: p.brand,
      model: p.model,
      colorway: p.colorway,
      title,
      fullName: named.name,
      description: desc.trim(),
      dept,
      sizes,
      photos,
      cover: photos[0] || 0,
      price,
      priceMax,
      oldPrice: sp ? sp.oldPrice : 0,
      discount: sp ? sp.discount : 0,
      saleTo: sp ? sp.saleTo : '',
      priceSource: sp ? 'site' : 'warehouse',
      qty: inStock.reduce((a, s) => a + s.qty, 0),
      inStock: inStock.length > 0,
      createdAt: created.length ? Math.max(...created) : 0,
      search: '',
    });
  }
  return models;
}

module.exports = { DEPARTMENTS, splitSku, parseName, deptOf, buildModels, sizeOrder, sitePrice, TYPE_TO_DEPT };
