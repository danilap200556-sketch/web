'use strict';
// Второй источник электроники: bazaplay.ru (магазин BAZA, сайт на 1С-Битрикс). Каталог берём по sitemap.xml, а у каждого товара читаем
// его страницу: в ней лежит конфиг Bitrix (JCCatalogElement) с названием, ценой, наличием (CAN_BUY), фото и категорией, плюс хлебные крошки.
// Ходит и перепроверяет товары общий сервис из partner.js (вежливо: robots.txt, паузы, повторы); здесь только разбор страниц.
const cheerio = require('cheerio');
const { detectBrand } = require('./ext');

const SITEMAP_SKIP = /files/i;          // sitemap-files.xml - это файлы для скачивания, не страницы
const NOT_PRODUCT = new Set(['compare', 'uslugi']); // служебные разделы каталога и услуги (установка, перенос данных): это не товары

const decode = (s) => String(s || '')
  .replace(/\\(['"\/\\])/g, '$1')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#8381;/g, '₽').replace(/&middot;/g, '·')
  .replace(/\s+/g, ' ').trim();

// Страница товара. null - это не товар (раздел, ошибка) или разметка не узнана.
function parseProduct(html, base = '') {
  const text = String(html || '');
  if (!/JCCatalogElement/.test(text)) return null;
  const i = text.indexOf("'PRODUCT':{");
  if (i < 0) return null;
  const end = text.indexOf("'BASKET'", i);
  const seg = text.slice(i, end > i ? end : i + 14000);
  const name = /'NAME':'((?:[^'\\]|\\.)*)'/.exec(seg);
  if (!name) return null;
  const title = decode(name[1]);
  if (!title) return null;
  const prices = /'ITEM_PRICES':\[\{(.*?)\}\]/s.exec(seg);
  const priceSrc = prices ? prices[1] : seg;
  const price = Math.round(Number(/'PRICE':'([\d.]+)'/.exec(priceSrc)?.[1]) || 0);
  const basePrice = Math.round(Number(/'BASE_PRICE':'([\d.]+)'/.exec(priceSrc)?.[1]) || 0);
  const origin = base ? String(base).replace(/\/+$/, '') : '';
  const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${origin}${p.startsWith('/') ? '' : '/'}${p}`);
  const slider = /'SLIDER':\[(.*?)\]/s.exec(seg);
  const pict = /'PICT':\{[^}]*?'SRC':'([^']+)'/.exec(seg);
  const images = [];
  for (const src of [...(slider ? [...slider[1].matchAll(/'SRC':'([^']+)'/g)].map((m) => m[1]) : []), ...(pict ? [pict[1]] : [])]) {
    const u = abs(decode(src));
    if (u && !images.includes(u)) images.push(u);
  }
  const category = decode(/'CATEGORY':'((?:[^'\\]|\\.)*)'/.exec(seg)?.[1] || '');
  const id = /'PRODUCT':\{'ID':'(\d+)'/.exec(seg)?.[1] || '';
  // Хлебные крошки: Главная > Каталог > разделы > название товара. Берём разделы.
  const $ = cheerio.load(text);
  const crumbs = ($('.breadcrumbs').first().html() || '').replace(/<[^>]+>/g, '\n').split('\n').map(decode).filter((x) => x && !/^[\/›>·|—-]+$/.test(x));
  const k = crumbs.findIndex((x) => /^каталог$/i.test(x));
  const parts = (k >= 0 ? crumbs.slice(k + 1) : crumbs.filter((x) => !/^главная$/i.test(x))).slice(0, -1);
  return {
    title,
    section: parts.join(' > '),
    sku: id ? `BZ-${id}` : '',
    brand: detectBrand(category) || '',
    description: '',
    images: images.slice(0, 8),
    price,
    oldPrice: basePrice > price && price > 0 ? basePrice : 0,
    inStock: /'CAN_BUY':true/.test(seg),
  };
}

const locs = (xml) => [...String(xml || '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const parseSitemap = locs;

// Из всех адресов sitemap оставляем товары: страницы каталога, под которыми нет других страниц (разделы - это папки).
function productPaths(urls, base) {
  const origin = new URL(base).origin;
  const list = [];
  const seen = new Set();
  for (const u of urls) {
    let p;
    try { const x = new URL(u); if (x.origin !== origin) continue; p = x.pathname; } catch { continue; }
    if (!p.startsWith('/catalog/')) continue;
    const segs = p.split('/').filter(Boolean);
    if (segs.length < 2 || segs.slice(1).some((x) => NOT_PRODUCT.has(x))) continue;
    const path = p.replace(/^\//, '');
    if (seen.has(path)) continue;   // в настоящей карте сайта адреса встречаются дважды
    seen.add(path);
    list.push({ path, segs });
  }
  const all = list.map((x) => `/${x.path}`);
  return list
    .filter((x) => !all.some((o) => o !== `/${x.path}` && o.startsWith(`/${x.path}`)))
    .map((x) => ({ path: x.path, section: x.segs.slice(1, -1).join(' > ') }));
}

// page(path) - страница сайта по правилам вежливого обхода (robots.txt, паузы, повторы). Возвращает { items: [{ path, section }], files }.
// sitemap.xml - либо список файлов карты (у Битрикса так), либо сразу список адресов. Файл «files» - документы для скачивания, он не нужен.
async function discoverProducts({ page, base }) {
  const root = await page('sitemap.xml');
  const urls = [];
  let files = 1;
  if (/<sitemapindex/i.test(root)) {
    const maps = [...new Set(locs(root).map((u) => { try { return new URL(u).pathname; } catch { return ''; } }))]
      .filter((p) => /\.xml$/i.test(p) && p !== '/sitemap.xml' && !SITEMAP_SKIP.test(p));
    for (const p of maps.slice(0, 20)) { urls.push(...locs(await page(p.replace(/^\//, '')))); files++; }
  } else urls.push(...locs(root));
  return { items: productPaths(urls, base), files };
}

const DETAIL_EVERY_MS = 2 * 86400_000; // цены у магазина меняются часто: карточку перечитываем раз в двое суток

const BAZA = {
  source: 'baza', name: 'BAZA (bazaplay.ru)', flag: 'BAZA_SYNC', defaultBase: 'https://bazaplay.ru',
  conf: (cfg) => cfg.baza, parseProduct: (html, base) => parseProduct(html, base), discover: discoverProducts, detailEveryMs: DETAIL_EVERY_MS, metaKey: 'ext_listing_baza',
};

module.exports = { parseProduct, parseSitemap, productPaths, discoverProducts, BAZA };
