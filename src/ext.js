'use strict';
// Товары партнёров (раздел «Электроника», сейчас Sergeev Electronics) как модели витрины. Лежат в webshop.ext_products,
// в каталоге выглядят как обычные модели с одним «размером»: так работают поиск, фильтры, корзина и заказ.
//
// Сквозные номера: у товара склада product_id - обычный номер (меньше EXT_BASE), у товара партнёра номер = EXT_BASE + id строки.
// Фото партнёра - отрицательные номера -(id * 10 + номер фото): так их отличают все места, где есть номер фото.
const { slugify } = require('./util');

const EXT_BASE = 1_000_000_000;
const EXT_STOCK = 5; // сколько штук можно положить в корзину: у партнёра известно только «есть» или «нет»

const extPid = (id) => EXT_BASE + id;
const isExtPid = (pid) => Number(pid) >= EXT_BASE;
const extPhoto = (id, i) => -(id * 10 + i);
const parseExtPhoto = (photoId) => { const n = -Number(photoId); return { id: Math.floor(n / 10), idx: n % 10 }; };

// Бренд: по названию (в том числе по названию линейки), затем по разделу партнёра
const BRANDS = ['Apple', 'Samsung', 'Dyson', 'Xiaomi', 'DJI', 'Garmin', 'GoPro', 'JBL', 'Realme', 'Sony', 'Marshall', 'Bose', 'Huawei', 'Honor',
  'Nothing', 'Google', 'Asus', 'Lenovo', 'Insta360', 'Anker', 'Beats', 'Oppo', 'Vivo', 'OnePlus', 'Sonos', 'Nintendo', 'Microsoft', 'Canon',
  'Nikon', 'Fujifilm', 'Harman Kardon', 'Bang & Olufsen', 'Meta', 'Oura', 'Steam', 'Valve', 'Logitech', 'Razer', 'HyperX', 'Tecno', 'Infinix', 'Poco'];
const ALIASES = [[/\b(iphone|ipad|macbook|imac|airpods|airtag|apple watch|magsafe|homepod|vision pro|mac mini|mac studio)\b/i, 'Apple'],
  [/\b(galaxy|odyssey)\b/i, 'Samsung'], [/\b(redmi|poco|mi band|xiaomi)\b/i, 'Xiaomi'], [/\b(osmo|mavic|mini 4|mini 5|avata|dji)\b/i, 'DJI'],
  [/\b(supersonic|airwrap|airstrait|corrale|purifier|v8|v10|v11|v12|v15|gen5)\b/i, 'Dyson'], [/\b(hero\d*|max \d)\b/i, 'GoPro']];
const SECTION_BRAND = { 'tekhnika-apple': 'Apple', 'tekhnika-samsung': 'Samsung', 'tekhnika-dyson': 'Dyson', 'tekhnika-xiaomi': 'Xiaomi', 'tekhnika-dji': 'DJI', garmin: 'Garmin', 'tekhnika-gopro': 'GoPro' };

function detectBrand(title, section = '') {
  const t = String(title || '');
  for (const b of BRANDS) if (new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(t)) return b === 'Poco' ? 'Xiaomi' : b;
  for (const [re, b] of ALIASES) if (re.test(t)) return b;
  return SECTION_BRAND[section] || '';
}

// Тип для фильтра «Тип»: по ключевым словам названия
const TYPES = [
  ['Смартфоны', /(смартфон|телефон|iphone)/i], ['Планшеты', /(планшет|ipad|tab\b)/i], ['Компьютеры и ноутбуки', /(ноутбук|macbook|компьютер|моноблок|imac|mac mini|mac studio)/i],
  ['Часы и браслеты', /(часы|браслет|watch|band\b)/i], ['Наушники', /(наушник|airpods|гарнитур|buds)/i], ['Колонки и звук', /(колонк|акустик|саундбар|homepod|микрофон)/i],
  ['Камеры и дроны', /(камер|дрон|квадрокоптер|osmo|gopro|hero|стабилизатор|insta360)/i], ['Техника для дома', /(пылесос|фен|стайлер|выпрямител|очистител|увлажнител|робот|мультистайлер|завивк)/i],
  ['Телевизоры и мониторы', /(телевизор|монитор|проектор)/i], ['Игровые приставки', /(playstation|xbox|nintendo|приставк|steam deck|джойстик|геймпад)/i],
  ['Аксессуары', /(кабель|адаптер|зарядк|чехол|стилус|pencil|клавиатур|мышь|метка|airtag|держател|штатив|пленк|стекло|переходник|блок питания|ремешок|powerbank|павербанк|аккумулятор)/i],
];
const typeOfTitle = (title) => { for (const [t, re] of TYPES) if (re.test(title)) return t; return 'Другая электроника'; };

const markup = (price, pct) => (pct > 0 ? Math.ceil((Number(price) * (1 + pct / 100)) / 10) * 10 : Math.round(Number(price)));

// rows: строки webshop.ext_products. opts.markupPct - наценка к цене партнёра в процентах (0 - цена как у партнёра),
// opts.showOldPrice - показывать ли зачёркнутую цену партнёра как скидку.
function buildExtModels(rows, { markupPct = 0, baseUrl = '', showOldPrice = false } = {}) {
  const out = [];
  for (const r of rows) {
    const price = markup(r.price, markupPct);
    if (!(price > 0)) continue;
    // Зачёркнутая цена партнёра показывается как скидка только если владелец это включил в админке: настоящая ли это скидка, мы не знаем
    const oldPrice = showOldPrice && r.old_price && Number(r.old_price) > Number(r.price) ? markup(r.old_price, markupPct) : 0;
    const discount = oldPrice ? Math.max(1, Math.min(99, Math.round((1 - price / oldPrice) * 100))) : 0;
    const images = Array.isArray(r.images) ? r.images.slice(0, 8) : [];
    const photos = images.map((_, i) => extPhoto(r.id, i));
    const brand = r.brand || detectBrand(r.title, r.section);
    const model = brand && String(r.title).toLowerCase().includes(brand.toLowerCase()) ? String(r.title).replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/\s+/g, ' ').trim() : String(r.title);
    const inStock = Boolean(r.in_stock);
    const slug = `e${r.id}-${slugify(r.path.split('/').pop())}`.slice(0, 90);
    out.push({
      key: `ext:${r.path}`,
      slug,
      type: typeOfTitle(r.title),
      brand,
      model: model || r.title,
      colorway: '',
      title: r.title, // как у партнёра («Смартфон Apple iPhone 18 Pro 256 Gb (Black)»); бренд на карточке отдельной меткой
      fullName: r.title,
      description: r.description || '',
      dept: 'electronics',
      sizes: [{ id: extPid(r.id), sku: `${r.source}:${r.path}`, size: '', note: '', label: 'В наличии', qty: inStock ? EXT_STOCK : 0, price, order: 0 }],
      photos,
      cover: photos[0] || 0,
      price,
      priceMax: price,
      oldPrice,
      discount,
      saleTo: '',
      priceSource: 'partner',
      qty: inStock ? EXT_STOCK : 0,
      inStock,
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
      search: '',
      ext: { id: r.id, source: r.source, path: r.path, url: baseUrl ? `${baseUrl}/${r.path}` : '', apiPrice: Number(r.price) },
    });
  }
  return out;
}

module.exports = { EXT_BASE, EXT_STOCK, extPid, isExtPid, extPhoto, parseExtPhoto, detectBrand, typeOfTitle, buildExtModels, markup };
