'use strict';
// Каталог в памяти. Товары, фото и остатки читаются из таблиц приложения «Склад» (только чтение),
// склеиваются в модели (см. model.js) и обновляются раз в `catalogTtl` секунд или по сигналу
// (заказ оформлен, админ скрыл модель).
const { buildModels, DEPARTMENTS } = require('./model');

const PAGE_SIZE = 24;
// Заказы в этих статусах держат товар в резерве: из остатка склада вычитаем, пока склад не списал его сам
const RESERVING = ['new', 'confirmed', 'paid', 'packed'];

// Заказ, который сотрудник уже списал в приложении «Склад» (очередь order_writeoffs), резервом быть перестаёт: его пары
// уже вычтены из остатка склада, второй раз вычитать нельзя. ok - доступна ли таблица очереди (иначе условия нет).
const queueFilter = (ok) => (ok
  ? `AND NOT EXISTS (SELECT 1 FROM order_writeoffs w WHERE w.source = 'site' AND w.account_id = 0 AND w.order_ref = o.number
                      AND w.state IN ('writing', 'written_off', 'cancel_requested', 'returning'))`
  : '');

// ---- Поиск ----
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-я]+/g, ' ').trim();

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const toRu = (s) => [...s].map((c) => { const i = EN.indexOf(c); return i < 0 ? c : RU[i]; }).join('');
const toEn = (s) => [...s].map((c) => { const i = RU.indexOf(c); return i < 0 ? c : EN[i]; }).join('');

// Как покупатели пишут по-русски то, что в каталоге написано латиницей
const ALIASES = {
  найк: 'nike', найки: 'nike', адидас: 'adidas', джордан: 'jordan', джорданы: 'jordan', асикс: 'asics', ванс: 'vans',
  угг: 'ugg', угги: 'ugg', пума: 'puma', тимберленд: 'timberland', карха: 'carhartt', кроксы: 'crocs', крокс: 'crocs',
  самба: 'samba', газель: 'gazelle', данк: 'dunk', данки: 'dunk', аир: 'air', эир: 'air', форс: 'force', макс: 'max',
  нью: 'new', баланс: 'balance', беланс: 'balance', ньюбаланс: 'new balance', изи: 'yeezy', йизи: 'yeezy', бутс: 'boost',
  хоку: 'hoka', хока: 'hoka', салломон: 'salomon', соломон: 'salomon', конверс: 'converse', рибок: 'reebok',
};

function altTokens(tok) {
  const out = new Set([tok]);
  if (ALIASES[tok]) for (const w of ALIASES[tok].split(' ')) out.add(w);
  // забыли переключить раскладку: "тшлу" -> nike, "ydlnhsdl" -> ...
  const ru = toRu(tok);
  const en = toEn(tok);
  if (/^[a-z0-9]+$/.test(tok) && ru !== tok) { out.add(ru); if (ALIASES[ru]) out.add(ALIASES[ru]); }
  if (/^[а-я]+$/.test(tok) && en !== tok) out.add(en);
  return [...out];
}

function indexModel(m) {
  const text = norm([m.brand, m.model, m.colorway, m.type, m.key, m.fullName].join(' '));
  m.search = text;
  m.words = [...new Set(text.split(' '))];
}

// Баллы совпадения модели с запросом; 0 - не подходит
function matchScore(m, tokens) {
  let total = 0;
  for (const alts of tokens) {
    let best = 0;
    for (const t of alts) {
      for (const w of m.words) {
        if (w === t) best = Math.max(best, 4);
        else if (w.startsWith(t)) best = Math.max(best, 3);
        else if (t.length >= 3 && /\d/.test(t) && w.includes(t)) best = Math.max(best, 2);
      }
      if (!best && t.length >= 4 && m.search.includes(t)) best = 1;
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

const parseQuery = (q) => norm(q).split(' ').filter(Boolean).slice(0, 8).map(altTokens);

// ---- Отбор по условиям ----
function arr(v) { return v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]; }

// В адресе отдел - slug (obuv, odezhda), у модели - ключ (shoes, clothes): сравнивать нужно по ключу.
const DEPT_BY_SLUG = Object.fromEntries(Object.entries(DEPARTMENTS).map(([k, v]) => [v.slug, k]));

function passes(m, c, except) {
  if (c.dept && except !== 'dept' && m.dept !== DEPT_BY_SLUG[c.dept]) return false;
  if (c.types.length && except !== 'type' && !c.types.includes(m.type)) return false;
  if (c.brands.length && except !== 'brand' && !c.brands.includes(m.brand)) return false;
  if (c.sizes.length && except !== 'size' && !m.sizes.some((s) => s.qty > 0 && c.sizes.includes(s.size))) return false;
  if (c.min && except !== 'price' && m.price < c.min) return false;
  if (c.max && except !== 'price' && m.price > c.max) return false;
  if (c.inStock && !m.inStock) return false;
  if (c.sale && !m.oldPrice) return false;
  if (c.keys && !c.keys.has(m.key)) return false;
  return true;
}

function countBy(list, pick) {
  const map = new Map();
  for (const m of list) for (const v of pick(m)) if (v) map.set(v, (map.get(v) || 0) + 1);
  return map;
}

function normalizeCriteria(raw = {}) {
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  return {
    q: String(raw.q || '').trim().slice(0, 80),
    dept: raw.dept && Object.values(DEPARTMENTS).some((d) => d.slug === raw.dept) ? raw.dept : '',
    types: arr(raw.type).map(String).slice(0, 20),
    brands: arr(raw.brand).map(String).slice(0, 20),
    sizes: arr(raw.size).map(String).slice(0, 40),
    min: num(raw.min),
    max: num(raw.max),
    inStock: raw.all === '1' ? false : true,
    sale: raw.sale === '1',
    sort: ['new', 'price_asc', 'price_desc', 'discount', 'popular'].includes(raw.sort) ? raw.sort : 'popular',
    page: Math.max(1, num(raw.page) || 1),
    keys: raw.keys instanceof Set ? raw.keys : null,
  };
}

class Catalog {
  constructor(db, cfg, settings) {
    this.db = db;
    this.ttl = cfg.catalogTtl * 1000;
    this.settings = settings;
    this.tz = cfg.tz;
    this.sitePricesState = null;
    this.queueOk = null; // null - ещё не проверяли; false - очереди списания нет
    this.models = [];
    this.bySlug = new Map();
    this.byProduct = new Map();
    this.loadedAt = 0;
    this.pending = null;
    this.deptSlugs = new Map(Object.entries(DEPARTMENTS).map(([k, v]) => [v.slug, k]));
  }

  invalidate() { this.loadedAt = 0; }

  async ensure() {
    if (Date.now() - this.loadedAt < this.ttl && this.loadedAt) return;
    if (!this.pending) {
      this.pending = this.load().finally(() => { this.pending = null; });
    }
    await this.pending;
  }

  async load() {
    const { db } = this;
    const [prod, photos, reserved, flags, cfg, sitePrices] = await Promise.all([
      db.query(`SELECT p.id, p.sku, p.name, p.description, p.price::float8 AS price, COALESCE(p.market_vendor, '') AS vendor,
                       COALESCE(p.market_category_name, '') AS category, p.created_at, GREATEST(COALESCE(st.q, 0), 0)::int AS qty
                  FROM products p
                  LEFT JOIN (SELECT product_id, SUM(quantity)::int AS q FROM stock GROUP BY product_id) st ON st.product_id = p.id`),
      db.query('SELECT product_id, id FROM product_photos ORDER BY product_id, position, id'),
      this.loadReserved(),
      db.query('SELECT model_key, hidden, featured, badge FROM webshop.model_flags'),
      this.settings.get(),
      this.loadSitePrices(),
    ]);
    const photoMap = new Map();
    for (const r of photos.rows) {
      if (!photoMap.has(r.product_id)) photoMap.set(r.product_id, []);
      photoMap.get(r.product_id).push(r.id);
    }
    const rows = prod.rows.map((r) => ({ ...r, photos: photoMap.get(r.id) || [] }));
    const resMap = new Map(reserved.map((r) => [r.product_id, r.q]));
    const flagMap = new Map(flags.rows.map((f) => [f.model_key, f]));

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz }).format(new Date()); // YYYY-MM-DD в часовом поясе магазина
    const all = buildModels(rows, { reserved: resMap, sitePrices, today });
    const models = [];
    for (const m of all) {
      const f = flagMap.get(m.key);
      m.hideReason = f && f.hidden ? 'manual' : '';
      m.featured = !!(f && f.featured);
      m.badge = (f && f.badge) || '';
      if (!m.hideReason && cfg.requirePhoto && !m.photos.length) m.hideReason = 'no_photo';
      if (!m.hideReason && !m.price) m.hideReason = 'no_price'; // без цены продавать нельзя
      m.hidden = !!m.hideReason;
      indexModel(m);
      models.push(m);
    }
    this.allModels = models; // с учётом скрытых - для админки
    this.models = models.filter((m) => !m.hidden);
    this.bySlug = new Map(this.models.map((m) => [m.slug, m]));
    this.byKey = new Map(models.map((m) => [m.key, m]));
    this.byProduct = new Map();
    for (const m of models) for (const s of m.sizes) this.byProduct.set(s.id, { model: m, size: s });
    this.loadedAt = Date.now();
  }

  // Сколько пар держат в резерве незавершённые заказы. Нет очереди списания (таблицы нет или прав) - считаем без неё.
  async loadReserved() {
    const sql = (ok) => `SELECT oi.product_id, SUM(oi.qty)::int AS q
                           FROM webshop.order_items oi JOIN webshop.orders o ON o.id = oi.order_id
                          WHERE o.status = ANY($1) AND oi.product_id IS NOT NULL ${queueFilter(ok)} GROUP BY oi.product_id`;
    try {
      const r = await this.db.query(sql(this.queueOk !== false), [RESERVING]);
      return r.rows;
    } catch (e) {
      if (this.queueOk === false || (e.code !== '42P01' && e.code !== '42501')) throw e;
      this.queueOk = false; // без очереди списания: резерв по всем незавершённым заказам
      return (await this.db.query(sql(false), [RESERVING])).rows;
    }
  }

  // Цены и скидки сайта из таблицы site_prices (её ведёт приложение «Склад», вкладка «Цены сайта»).
  // Нет таблицы или прав - сайт работает на ценах склада, а причина видна в админке (this.sitePricesState).
  async loadSitePrices() {
    try {
      const { rows } = await this.db.query(
        `SELECT model_key, price::float8 AS price, sale_price::float8 AS sale_price,
                to_char(sale_from, 'YYYY-MM-DD') AS sale_from, to_char(sale_to, 'YYYY-MM-DD') AS sale_to
           FROM site_prices`);
      this.sitePricesState = { status: 'ok', count: rows.length };
      return new Map(rows.map((r) => [r.model_key, { price: r.price, salePrice: r.sale_price, from: r.sale_from || '', to: r.sale_to || '' }]));
    } catch (e) {
      const status = e.code === '42P01' ? 'missing' : e.code === '42501' ? 'denied' : 'error';
      if (!this.sitePricesState || this.sitePricesState.status !== status) console.warn(`[prices] цены сайта недоступны (${status}): ${e.message}. Используются цены склада.`);
      this.sitePricesState = { status, count: 0 };
      return new Map();
    }
  }

  // Поиск + отбор + сортировка + страница. Возвращает и счётчики для фильтров.
  search(raw = {}, { pageSize = PAGE_SIZE } = {}) {
    const c = normalizeCriteria(raw);
    const tokens = c.q ? parseQuery(c.q) : null;
    const scores = new Map();
    let base = this.models;
    if (tokens) {
      base = [];
      for (const m of this.models) {
        const s = matchScore(m, tokens);
        if (s) { scores.set(m, s); base.push(m); }
      }
    }
    const matched = base.filter((m) => passes(m, c));
    const sorted = matched.slice();
    const stockFirst = (a, b) => Number(b.inStock) - Number(a.inStock);
    const byNew = (a, b) => b.createdAt - a.createdAt;
    if (c.sort === 'price_asc') sorted.sort((a, b) => stockFirst(a, b) || a.price - b.price);
    else if (c.sort === 'price_desc') sorted.sort((a, b) => stockFirst(a, b) || b.price - a.price);
    else if (c.sort === 'new') sorted.sort((a, b) => stockFirst(a, b) || byNew(a, b));
    else if (c.sort === 'discount') sorted.sort((a, b) => stockFirst(a, b) || b.discount - a.discount || a.price - b.price);
    else {
      sorted.sort((a, b) => stockFirst(a, b) || Number(b.featured) - Number(a.featured) ||
        ((scores.get(b) || 0) - (scores.get(a) || 0)) || b.qty - a.qty || byNew(a, b));
    }
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(c.page, pages);
    const items = sorted.slice((page - 1) * pageSize, page * pageSize);

    // Счётчики для фильтров считаем без самого фильтра, чтобы можно было расширить выбор
    const forBrand = base.filter((m) => passes(m, c, 'brand'));
    const forType = base.filter((m) => passes(m, c, 'type'));
    const forSize = base.filter((m) => passes(m, c, 'size'));
    const forPrice = base.filter((m) => passes(m, c, 'price'));
    const brands = [...countBy(forBrand, (m) => [m.brand])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const types = [...countBy(forType, (m) => [m.type])].sort((a, b) => b[1] - a[1]);
    const sizeCounts = countBy(forSize, (m) => m.sizes.filter((s) => s.qty > 0 && s.size).map((s) => s.size));
    const sizes = [...sizeCounts].sort((a, b) => sizeOrderOf(a[0]) - sizeOrderOf(b[0]));
    const prices = forPrice.map((m) => m.price).filter(Boolean);
    return {
      criteria: c, items, total, page, pages, pageSize,
      facets: { brands, types, sizes, priceMin: prices.length ? Math.min(...prices) : 0, priceMax: prices.length ? Math.max(...prices) : 0 },
    };
  }

  suggest(q, limit = 6) {
    const tokens = parseQuery(q);
    if (!tokens.length) return { items: [], brands: [] };
    const scored = [];
    for (const m of this.models) {
      const s = matchScore(m, tokens);
      if (s) scored.push([m, s + (m.inStock ? 2 : 0) + (m.featured ? 1 : 0)]);
    }
    scored.sort((a, b) => b[1] - a[1] || b[0].createdAt - a[0].createdAt);
    const brandCount = new Map();
    for (const [m] of scored) if (m.brand) brandCount.set(m.brand, (brandCount.get(m.brand) || 0) + 1);
    return {
      total: scored.length,
      items: scored.slice(0, limit).map(([m]) => m),
      brands: [...brandCount].sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }

  // Похожие: тот же тип, сначала тот же бренд
  related(m, n = 8) {
    return this.models
      .filter((x) => x.key !== m.key && x.inStock && x.type === m.type)
      .map((x) => [x, (x.brand === m.brand ? 2 : 0) + (x.featured ? 1 : 0) + Math.abs(Math.sin(hash(x.key + m.key))) ])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map((x) => x[0]);
  }

  onSale(n = 8) {
    return this.models.filter((m) => m.inStock && m.oldPrice && m.cover).sort((a, b) => b.discount - a.discount || b.qty - a.qty).slice(0, n);
  }

  newest(n = 8, filter = () => true) {
    return this.models.filter((m) => m.inStock && filter(m)).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
  }

  deptKey(slug) { return this.deptSlugs.get(slug) || ''; }

  stats() {
    const visible = this.models;
    return {
      models: visible.length,
      inStock: visible.filter((m) => m.inStock).length,
      hidden: (this.allModels || []).length - visible.length,
      onSale: visible.filter((m) => m.inStock && m.oldPrice).length,
      brands: new Set(visible.map((m) => m.brand).filter(Boolean)).size,
    };
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
const { sizeOrder: sizeOrderOf } = require('./model');

module.exports = { Catalog, PAGE_SIZE, RESERVING, queueFilter, norm, hash, normalizeCriteria };
