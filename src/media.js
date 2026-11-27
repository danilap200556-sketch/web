'use strict';
// Фото товаров лежат в базе склада (product_photos.data, JPEG до 1280 px). Сайт отдаёт их в трёх размерах,
// масштабирует на лету и держит готовое в памяти. Id фото не меняется (заменённое фото получает новый id),
// поэтому браузеру можно разрешить кэшировать навсегда.
//
// Фон у фото из разных магазинов разный: чисто белый, серый, кремовый. Чтобы на карточках не было «рамок»,
// цвет фона читается по углам снимка, и если он светлый и ровный, фон приводится к белому (дальше CSS
// накладывает его на цвет карточки режимом multiply, и фото сливается с карточкой).
const crypto = require('node:crypto');
const sharp = require('sharp');
const { studio } = require('./photofix');
const { OWN_BASE } = require('./ext');

// Версия вида фото: входит в ключи кэша и в адрес картинки (?v=), чтобы браузеры не держали старое фото после смены обработки
const LOOK = 2;

sharp.cache(false);
sharp.concurrency(2);

const WIDTHS = new Set([360, 640, 1280]);
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_GAIN = 1.22;

class ByteLru {
  constructor(max) { this.max = max; this.size = 0; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (!v) return null;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    const old = this.map.get(k);
    if (old) this.size -= old.buf.length;
    this.map.set(k, v);
    this.size += v.buf.length;
    for (const [key, val] of this.map) {
      if (this.size <= this.max) break;
      this.map.delete(key);
      this.size -= val.buf.length;
    }
  }
}

// Углы снимка 48x48: средний цвет каждого, разброс между ними
async function backdrop(data) {
  const N = 48;
  const raw = await sharp(data).resize(N, N, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const corner = (x0, y0) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) { const i = (y * N + x) * 3; r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++; }
    return [r / n, g / n, b / n];
  };
  const cs = [corner(0, 0), corner(N - 4, 0), corner(0, N - 4), corner(N - 4, N - 4)];
  const mean = [0, 1, 2].map((c) => cs.reduce((a, x) => a + x[c], 0) / 4);
  const spread = Math.max(...[0, 1, 2].map((c) => Math.max(...cs.map((x) => x[c])) - Math.min(...cs.map((x) => x[c]))));
  return { mean, spread };
}

// { gain: [r,g,b] | null, clean: boolean } - можно ли выбелить фон и получится ли он ровным
async function analyse(data) {
  try {
    const { mean, spread } = await backdrop(data);
    const lo = Math.min(...mean);
    const hi = Math.max(...mean);
    if (spread > 14 || lo < 205 || hi - lo > 38) return { gain: null, clean: false };
    const gain = mean.map((m) => 255 / m);
    if (Math.max(...gain) > MAX_GAIN) return { gain: null, clean: false };
    return { gain: lo >= 252 ? null : gain, clean: true };
  } catch {
    return { gain: null, clean: false };
  }
}

function createMedia(db, { partner, studio: useStudio = true, disk = null } = {}) {
  const cache = new ByteLru(MAX_BYTES);
  const inflight = new Map();
  const infoCache = new Map(); // id фото -> { gain, clean }

  async function load(id) {
    // Фото своих товаров лежат в базе сайта (webshop.own_photos), номер = OWN_BASE + id строки; фото склада - в product_photos
    if (id >= OWN_BASE) {
      const own = await db.query('SELECT data FROM webshop.own_photos WHERE id = $1', [id - OWN_BASE]);
      return own.rows[0] ? own.rows[0].data : null;
    }
    const { rows } = await db.query('SELECT data FROM product_photos WHERE id = $1', [id]);
    return rows[0] ? rows[0].data : null;
  }

  async function info(id, data) {
    if (infoCache.has(id)) return infoCache.get(id);
    const buf = data || await load(id);
    const r = buf ? await analyse(buf) : { gain: null, clean: false };
    if (infoCache.size > 20000) infoCache.clear();
    infoCache.set(id, r);
    return r;
  }

  // Фото с чистым светлым фоном (для крупных плашек на главной)
  async function isClean(id) {
    if (!id || id < 0) return false;
    return (await info(id)).clean;
  }

  // Готовые файлы лежат ещё и на диске (см. mediacache.js): после перезапуска сайта фото не обрабатываются заново.
  // Имя файла включает размер, формат, версию вида (LOOK) и режим обработки: смена любого из них даёт новый файл.
  const sha = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 14);
  const diskOn = () => Boolean(disk && disk.enabled());
  const flavor = (w, webp) => `${w}_${webp ? 'w' : 'j'}_${LOOK}${useStudio ? 's' : 'n'}.${webp ? 'webp' : 'jpg'}`;
  async function viaDisk(name, webp, make) {
    if (diskOn()) {
      const buf = await disk.get(name);
      if (buf) return { buf, type: webp ? 'image/webp' : 'image/jpeg', at: Date.now() };
    }
    const out = await make();
    if (out && diskOn()) disk.set(name, out.buf).catch(() => {});      // запись на диск ответ не задерживает
    return out;
  }

  async function render(id, w, webp) {
    const data = await load(id);
    if (!data) return null;
    if (useStudio) {
      try { return await studio(data, w, webp); } catch { /* файл не читается как картинка: ниже обычная обработка */ }
    }
    const { gain } = await info(id, data);
    let img = sharp(data).rotate().resize({ width: w, withoutEnlargement: true });
    if (gain) img = img.linear(gain, [0, 0, 0]);
    img = webp ? img.webp({ quality: 80 }) : img.jpeg({ quality: 82, mozjpeg: true });
    return { buf: await img.toBuffer(), type: webp ? 'image/webp' : 'image/jpeg' };
  }

  // Фото товара партнёра: скачивается с их сайта, сжимается и держится в памяти час (список фото карточки может обновиться).
  // Скачанный оригинал и готовые файлы лежат на диске: один оригинал обслуживает все размеры и форматы, а после перезапуска
  // сайта ничего не нужно скачивать и обрабатывать заново. Имя файла включает адрес картинки: сменилась картинка - новый файл.
  async function renderExt(id, idx, w, webp) {
    const url = partner && partner.imageUrl ? await partner.imageUrl(id, idx) : '';
    const make = async () => {
      let buf = null;
      const origName = url ? `o_${sha(url)}.bin` : '';
      if (origName && diskOn()) buf = await disk.get(origName);
      if (!buf) {
        const src = partner ? await partner.fetchImage(id, idx) : null;
        if (!src) return null;
        buf = src.buf;
        if (origName && diskOn()) disk.set(origName, buf).catch(() => {});
      }
      if (useStudio) {
        try { return { ...(await studio(buf, w, webp)), at: Date.now() }; } catch { /* ниже обычная обработка */ }
      }
      let img = sharp(buf).rotate().flatten({ background: '#ffffff' }).resize({ width: w, withoutEnlargement: true });
      img = webp ? img.webp({ quality: 80 }) : img.jpeg({ quality: 82, mozjpeg: true });
      return { buf: await img.toBuffer(), type: webp ? 'image/webp' : 'image/jpeg', at: Date.now() };
    };
    return url ? viaDisk(`x${id}_${idx}_${sha(url)}_${flavor(w, webp)}`, webp, make) : make();
  }

  function mount(app) {
    app.get('/media/x/:n/:w.jpg', async (req, res) => {
      const n = parseInt(req.params.n, 10);
      const w = parseInt(req.params.w, 10);
      if (!partner || !Number.isInteger(n) || n <= 0 || !WIDTHS.has(w)) return res.status(404).end();
      const webp = /image\/webp/.test(req.get('accept') || '');
      const key = `x${n}:${w}:${webp ? 'w' : 'j'}:${LOOK}`;
      res.set({ 'Cache-Control': 'public, max-age=86400', Vary: 'Accept' });
      let hit = cache.get(key);
      if (hit && Date.now() - hit.at > 3600_000) hit = null;
      if (!hit) {
        let p = inflight.get(key);
        if (!p) { p = renderExt(Math.floor(n / 10), n % 10, w, webp).finally(() => inflight.delete(key)); inflight.set(key, p); }
        try { hit = await p; } catch (e) { console.error('[media]', e.message); return res.status(502).set('Cache-Control', 'no-store').end(); }
        if (!hit) return res.status(404).set('Cache-Control', 'no-store').end();
        cache.set(key, hit);
      }
      res.type(hit.type).send(hit.buf);
    });

    app.get('/media/p/:id/:w.jpg', async (req, res) => {
      const id = parseInt(req.params.id, 10);
      const w = parseInt(req.params.w, 10);
      if (!Number.isInteger(id) || id <= 0 || !WIDTHS.has(w)) return res.status(404).end();
      const webp = /image\/webp/.test(req.get('accept') || '');
      const key = `${id}:${w}:${webp ? 'w' : 'j'}:${LOOK}`;
      const etag = `"${key}"`;
      res.set({ 'Cache-Control': 'public, max-age=2592000, immutable', Vary: 'Accept', ETag: etag });
      if (req.get('if-none-match') === etag) return res.status(304).end();
      let hit = cache.get(key);
      if (!hit) {
        let p = inflight.get(key);
        if (!p) {
          p = viaDisk(`p${id}_${flavor(w, webp)}`, webp, () => render(id, w, webp)).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        try { hit = await p; } catch (e) { console.error('[media]', e.message); return res.status(500).end(); }
        if (!hit) return res.status(404).set('Cache-Control', 'no-store').end();
        cache.set(key, hit);
      }
      res.type(hit.type).send(hit.buf);
    });
  }

  return { mount, isClean, analyse, dropMemory: () => { cache.map.clear(); cache.size = 0; infoCache.clear(); } };
}

module.exports = { createMedia, analyse, LOOK };
