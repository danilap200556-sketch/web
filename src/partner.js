'use strict';
// Каталог электроники партнёра (Sergeev Electronics, https://sergeev-electronics.ru): ассортимент, цены, наличие и фото
// подтягиваются с их сайта в webshop.ext_products и показываются в разделе «Электроника». Сайт партнёра на OpenCart.
//
// Ходим вежливо: соблюдаем robots.txt (в том числе Crawl-delay), делаем паузы между запросами (по умолчанию 3 секунды),
// при ошибках сервера и обрывах соединения ждём и повторяем, при 429 замедляемся. Разбор страниц категорий - раз в 6 часов,
// карточки товаров (описание, фото, точная цена) подтягиваются порциями в промежутках. Перед оформлением заказа цена и
// наличие конкретного товара перепроверяются прямо на их странице.
const cheerio = require('cheerio');

const SECTIONS = ['tekhnika-apple', 'tekhnika-samsung', 'tekhnika-dyson', 'tekhnika-xiaomi', 'tekhnika-dji', 'garmin', 'tekhnika-gopro', 'aksessuary'];
const LISTING_EVERY_MS = 6 * 3600_000;
const DETAIL_EVERY_MS = 7 * 86400_000;
const MAX_PAGES = 120;
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

class PartnerError extends Error {
  constructor(message, { transient = false, status = 0 } = {}) { super(message); this.transient = transient; this.status = status; }
}

// ---------- robots.txt ----------
function patternToRegex(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

function parseRobots(text) {
  const rules = [];
  let delay = 0;
  let applies = false;
  let seenAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') { if (!seenAgent) applies = false; seenAgent = true; if (v === '*') applies = true; continue; }
    seenAgent = false;
    if (!applies) continue;
    if (k === 'crawl-delay') delay = Math.max(delay, parseFloat(v) || 0);
    if ((k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', len: v.length, re: patternToRegex(v) });
  }
  return {
    delay,
    allows(pathWithQuery) {
      let best = null;
      for (const r of rules) if (r.re.test(pathWithQuery) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return !best || best.allow;
    },
  };
}

// ---------- разбор страниц ----------
const parsePrice = (text) => {
  const m = /(\d[\d\s ]*)(?:[.,]\d+)?\s*₽/.exec(String(text || ''));
  return m ? Number(m[1].replace(/[\s ]/g, '')) : 0;
};

function pathOf(href, base) {
  try {
    const u = new URL(href, base + '/');
    if (u.origin !== new URL(base).origin) return '';
    const p = u.pathname.replace(/^\/+|\/+$/g, '');
    return p && !p.includes('..') ? p : '';
  } catch { return ''; }
}

function parseListing(html, base) {
  const $ = cheerio.load(html);
  const items = [];
  $('.products__item').each((_, el) => {
    const $el = $(el);
    const a = $el.find('a.products__item-title').first();
    const path = pathOf(a.attr('href') || '', base);
    const title = a.text().replace(/\s+/g, ' ').trim();
    if (!path || !title) return;
    const priceEl = $el.find('.products__item-price').first();
    const price = parsePrice(priceEl.find('ins').first().text()) || parsePrice(priceEl.text());
    const oldPrice = parsePrice(priceEl.find('del').first().text());
    let image = '';
    $el.find('.products__item-image img').each((__, img) => {
      const src = $(img).attr('src') || '';
      const data = $(img).attr('data-src') || '';
      const pick = /^https?:/.test(src) ? src : data;
      if (!image && /^https?:/.test(pick)) image = pick;
    });
    items.push({ path, title, price, oldPrice: oldPrice > price ? oldPrice : 0, inStock: $el.find('.products__item-status--true').length > 0, image });
  });
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => parseInt(m[1], 10)).filter((n) => n > 0 && n <= MAX_PAGES);
  return { items, maxPage: pages.length ? Math.max(...pages) : 1 };
}

// Картинки одной карточки приходят в нескольких размерах (100, 500, 1000): оставляем самый большой каждой
function bestImages(urls) {
  const best = new Map();
  for (const u of urls) {
    const m = /^(.*)-(\d+)x(\d+)(\.\w+)$/.exec(u);
    const key = m ? m[1] + m[4] : u;
    const w = m ? parseInt(m[2], 10) : 0;
    if (!best.has(key) || w > best.get(key).w) best.set(key, { u, w });
  }
  return [...best.values()].filter((x) => x.w === 0 || x.w >= 300).map((x) => x.u);
}

function parseProduct(html, base) {
  const $ = cheerio.load(html);
  let prod = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).contents().text());
      for (const x of Array.isArray(j) ? j : [j]) if (x && x['@type'] === 'Product') prod = x;
    } catch { /* битая разметка на странице: пропускаем блок */ }
  });
  if (!prod) return null;
  const offers = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers || {};
  const imgs = (Array.isArray(prod.image) ? prod.image : [prod.image]).filter((u) => typeof u === 'string').map((u) => { try { return new URL(u, base + '/').toString(); } catch { return ''; } }).filter((u) => u && new URL(u).origin === new URL(base).origin);
  const desc = cheerio.load(`<div>${String(prod.description || '').replace(/<\/(p|div|li|h\d|tr)>|<br\s*\/?>/gi, ' ')}</div>`)('div').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
  return {
    sku: String(prod.sku || ''),
    brand: typeof prod.brand === 'string' ? prod.brand : (prod.brand && prod.brand.name) || '',
    description: desc,
    images: bestImages(imgs).slice(0, 8),
    price: Number(String(offers.price || '').replace(/[^\d.]/g, '')) || 0,
    inStock: /InStock/i.test(String(offers.availability || '')),
  };
}

// ---------- сервис ----------
function createPartner({ db, cfg, fetchImpl = fetch, sleep = sleepReal, log = console }) {
  const c = cfg.partner || {};
  const base = String(c.baseUrl || 'https://sergeev-electronics.ru').replace(/\/+$/, '');
  const source = 'sergeev';
  // Заголовки HTTP - только латиница: кириллица в User-Agent роняет запрос
  const ua = `SolehouseCatalogSync/1.0 (partner catalog sync for an online store${cfg.publicUrl ? '; ' + cfg.publicUrl : ''})`.replace(/[^\x20-\x7e]/g, '?');
  const state = { running: '', timer: null, first: null, robots: null, robotsAt: 0, last: 0, slow: 0, verifyCache: new Map(), imgSem: 0 };
  const enabled = () => Boolean(c.enabled);
  const gapMs = () => Math.max(Number(c.delayMs ?? 3000), state.robots ? state.robots.delay * 1000 : 0) + state.slow;

  async function throttle() {
    const wait = state.last + gapMs() - Date.now();
    if (wait > 0) await sleep(wait);
    state.last = Date.now();
  }

  async function http(path, { retries = 3, timeoutMs = 25_000, accept = 'text/html,application/xhtml+xml' } = {}) {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      try {
        const res = await fetchImpl(base + path, { headers: { 'user-agent': ua, accept, 'accept-language': 'ru' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429) state.slow = Math.min(state.slow + 2000, 20_000); // нас просят реже: замедляемся и дальше
          throw new PartnerError(`HTTP ${res.status}`, { transient: true, status: res.status });
        }
        if (!res.ok) throw new PartnerError(`HTTP ${res.status}`, { status: res.status });
        return res;
      } catch (e) {
        const transient = e instanceof PartnerError ? e.transient : true; // обрыв, таймаут, DNS
        if (!transient || attempt >= retries) throw e instanceof PartnerError ? e : new PartnerError(`сайт партнёра недоступен: ${e.cause && e.cause.code ? e.cause.code : e.message}`, { transient: true });
        await sleep(15_000 * (attempt + 1));
      }
    }
  }

  async function ensureRobots() {
    if (state.robots && Date.now() - state.robotsAt < 3600_000) return;
    try {
      const res = await http('/robots.txt', { retries: 1 });
      state.robots = parseRobots(await res.text());
    } catch (e) {
      if (e instanceof PartnerError && e.status === 404) state.robots = parseRobots(''); // файла нет - ограничений нет
      else if (!state.robots) throw e; // не смогли узнать правила - не ходим
    }
    state.robotsAt = Date.now();
  }

  async function page(path, opts) {
    await ensureRobots();
    if (!state.robots.allows('/' + path.replace(/^\/+/, ''))) throw new PartnerError(`robots.txt партнёра не разрешает ${path}`);
    return (await http('/' + path.replace(/^\/+/, ''), opts)).text();
  }

  const meta = async (key) => { const { rows } = await db.query('SELECT value FROM webshop.meta WHERE key = $1', [key]); try { return rows[0] ? JSON.parse(rows[0].value) : null; } catch { return null; } };
  const setMeta = (key, v) => db.query(`INSERT INTO webshop.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(v)]);

  async function upsertListing(items, section) {
    for (const it of items) {
      if (!(it.price > 0)) continue;
      await db.query(
        `INSERT INTO webshop.ext_products (source, path, section, title, price, old_price, in_stock, images, seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
         ON CONFLICT (source, path) DO UPDATE SET
           title = EXCLUDED.title, section = EXCLUDED.section, price = EXCLUDED.price, old_price = EXCLUDED.old_price,
           in_stock = EXCLUDED.in_stock, seen_at = NOW(),
           images = CASE WHEN webshop.ext_products.detail_at IS NULL THEN EXCLUDED.images ELSE webshop.ext_products.images END`,
        [source, it.path, section, it.title, it.price, it.oldPrice || null, it.inStock, JSON.stringify(it.image ? [it.image] : [])]);
    }
  }

  // Разбор категорий: страница за страницей. Что не встретилось за весь удачный обход, считаем снятым с продажи.
  async function syncListings() {
    if (state.running) return { skipped: true };
    state.running = 'listing';
    const started = new Date();
    const result = { at: started.toISOString(), pages: 0, items: 0, sections: 0, error: '' };
    try {
      const sections = (c.sections && c.sections.length ? c.sections : SECTIONS);
      for (const section of sections) {
        let maxPage = 1;
        for (let p = 1; p <= maxPage && p <= MAX_PAGES; p++) {
          const html = await page(`${section}${p > 1 ? `?page=${p}` : ''}`);
          const parsed = parseListing(html, base);
          if (p === 1) maxPage = parsed.maxPage;
          if (!parsed.items.length) break;
          await upsertListing(parsed.items, section);
          result.pages++; result.items += parsed.items.length;
          if (c.onProgress) c.onProgress(result);
        }
        result.sections++;
      }
      await db.query("UPDATE webshop.ext_products SET in_stock = FALSE WHERE source = $1 AND seen_at < $2 AND in_stock", [source, started]);
    } catch (e) {
      result.error = e.message;
      log.warn(`[partner] обход каталога прерван: ${e.message}`);
    } finally {
      result.finishedAt = new Date().toISOString();
      state.running = '';
      await setMeta('ext_listing', result).catch(() => {});
    }
    return result;
  }

  async function saveDetail(row, d) {
    await db.query(
      `UPDATE webshop.ext_products SET description = $2, images = CASE WHEN $3::jsonb = '[]'::jsonb THEN images ELSE $3::jsonb END,
              brand = CASE WHEN brand = '' THEN $4 ELSE brand END, sku = $5, price = CASE WHEN $6 > 0 THEN $6 ELSE price END,
              in_stock = $7, detail_at = NOW() WHERE id = $1`,
      [row.id, d.description, JSON.stringify(d.images), d.brand || '', d.sku, d.price, d.inStock]);
  }

  // Карточки товаров порциями: описание, большие фото, точная цена
  async function syncDetails({ limit = 12 } = {}) {
    if (state.running) return { skipped: true };
    state.running = 'details';
    let done = 0;
    try {
      const { rows } = await db.query(
        `SELECT id, path FROM webshop.ext_products WHERE source = $1 AND seen_at > NOW() - INTERVAL '3 days'
            AND (detail_at IS NULL OR detail_at < NOW() - make_interval(secs => $2))
          ORDER BY (detail_at IS NULL) DESC, in_stock DESC, id LIMIT $3`, [source, DETAIL_EVERY_MS / 1000, limit]);
      for (const row of rows) {
        try {
          const d = parseProduct(await page(row.path), base);
          if (d) { await saveDetail(row, d); done++; } else await db.query('UPDATE webshop.ext_products SET detail_at = NOW() WHERE id = $1', [row.id]);
        } catch (e) {
          if (e instanceof PartnerError && e.status === 404) await db.query('UPDATE webshop.ext_products SET in_stock = FALSE, detail_at = NOW() WHERE id = $1', [row.id]);
          else if (e instanceof PartnerError && e.transient) throw e; // сайт недоступен: остановимся, продолжим на следующем проходе
          else log.warn(`[partner] ${row.path}: ${e.message}`);
        }
      }
    } catch (e) {
      log.warn(`[partner] карточки: ${e.message}`);
    } finally {
      state.running = '';
    }
    return { done };
  }

  // Свежие цена и наличие товара перед оформлением заказа. null - узнать не удалось (сайт партнёра недоступен).
  async function verify(path) {
    const hit = state.verifyCache.get(path);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    try {
      const d = parseProduct(await page(path, { retries: 0, timeoutMs: 8000 }), base);
      if (!d || !(d.price > 0)) return null;
      const { rows } = await db.query('SELECT id FROM webshop.ext_products WHERE source = $1 AND path = $2', [source, path]);
      if (rows[0]) await saveDetail(rows[0], d);
      const v = { price: d.price, inStock: d.inStock };
      state.verifyCache.set(path, { at: Date.now(), v });
      if (state.verifyCache.size > 300) state.verifyCache.delete(state.verifyCache.keys().next().value);
      return v;
    } catch (e) {
      if (e instanceof PartnerError && e.status === 404) return { price: 0, inStock: false };
      log.warn(`[partner] проверка ${path}: ${e.message}`);
      return null;
    }
  }

  // Фото: только с сайта партнёра (другие адреса не качаем), через простую очередь на 3 одновременных загрузки
  async function fetchImage(id, idx) {
    const { rows } = await db.query('SELECT images FROM webshop.ext_products WHERE id = $1', [id]);
    const url = rows[0] && Array.isArray(rows[0].images) ? rows[0].images[idx] : '';
    if (!url) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.origin !== new URL(base).origin) return null;
    while (state.imgSem >= 3) await sleepReal(40);
    state.imgSem++;
    try {
      const res = await fetchImpl(u, { headers: { 'user-agent': ua, accept: 'image/*' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length && buf.length < 8 * 1024 * 1024 ? { buf, url } : null;
    } catch { return null; } finally { state.imgSem--; }
  }

  async function rows() {
    const r = await db.query(
      `SELECT id, source, path, section, title, brand, price, old_price, in_stock, images, created_at
         FROM webshop.ext_products WHERE source = $1 AND seen_at > NOW() - INTERVAL '3 days' ORDER BY id`, [source]);
    return r.rows;
  }
  async function description(id) {
    const r = await db.query('SELECT description FROM webshop.ext_products WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].description : '';
  }

  async function status() {
    const [l, cnt] = await Promise.all([meta('ext_listing'), db.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE in_stock)::int AS in_stock, COUNT(*) FILTER (WHERE detail_at IS NOT NULL)::int AS with_details
         FROM webshop.ext_products WHERE source = $1 AND seen_at > NOW() - INTERVAL '3 days'`, [source])]);
    return { enabled: enabled(), running: state.running, listing: l, ...cnt.rows[0], baseUrl: base };
  }

  async function tick() {
    if (!enabled() || state.running) return;
    try {
      const l = await meta('ext_listing');
      const stale = !l || !l.finishedAt || Date.now() - new Date(l.finishedAt).getTime() > LISTING_EVERY_MS || (l.error && Date.now() - new Date(l.finishedAt).getTime() > 600_000);
      if (stale) await syncListings(); else await syncDetails({ limit: 12 });
    } catch (e) { log.warn(`[partner] ${e.message}`); }
  }

  return {
    enabled, rows, description, status, verify, fetchImage, syncListings, syncDetails, tick, base,
    syncNow() { if (enabled() && !state.running) { syncListings(); return true; } return false; },
    start({ intervalMs = 60_000, firstMs = 20_000 } = {}) {
      if (!enabled() || c.autostart === false || state.timer) return;
      state.timer = setInterval(() => { tick(); }, intervalMs);
      state.timer.unref();
      state.first = setTimeout(() => { tick(); }, firstMs);
      state.first.unref();
    },
    async stop() { if (state.timer) { clearInterval(state.timer); state.timer = null; } if (state.first) { clearTimeout(state.first); state.first = null; } for (let i = 0; i < 100 && state.running; i++) await sleepReal(50); },
  };
}

module.exports = { createPartner, parseRobots, parseListing, parseProduct, parsePrice, bestImages, PartnerError, SECTIONS };
