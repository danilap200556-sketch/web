'use strict';
// Фото товаров лежат в базе склада (product_photos.data, JPEG до 1280 px). Сайт отдаёт их в трёх размерах,
// масштабирует на лету и держит готовое в памяти. Id фото не меняется (заменённое фото получает новый id),
// поэтому браузеру можно разрешить кэшировать навсегда.
//
// Фон у фото из разных магазинов разный: чисто белый, серый, кремовый. Чтобы на карточках не было «рамок»,
// цвет фона читается по углам снимка, и если он светлый и ровный, фон приводится к белому (дальше CSS
// накладывает его на цвет карточки режимом multiply, и фото сливается с карточкой).
const sharp = require('sharp');

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

function createMedia(db) {
  const cache = new ByteLru(MAX_BYTES);
  const inflight = new Map();
  const infoCache = new Map(); // id фото -> { gain, clean }

  async function load(id) {
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
    if (!id) return false;
    return (await info(id)).clean;
  }

  async function render(id, w, webp) {
    const data = await load(id);
    if (!data) return null;
    const { gain } = await info(id, data);
    let img = sharp(data).rotate().resize({ width: w, withoutEnlargement: true });
    if (gain) img = img.linear(gain, [0, 0, 0]);
    img = webp ? img.webp({ quality: 80 }) : img.jpeg({ quality: 82, mozjpeg: true });
    return { buf: await img.toBuffer(), type: webp ? 'image/webp' : 'image/jpeg' };
  }

  function mount(app) {
    app.get('/media/p/:id/:w.jpg', async (req, res) => {
      const id = parseInt(req.params.id, 10);
      const w = parseInt(req.params.w, 10);
      if (!Number.isInteger(id) || id <= 0 || !WIDTHS.has(w)) return res.status(404).end();
      const webp = /image\/webp/.test(req.get('accept') || '');
      const key = `${id}:${w}:${webp ? 'w' : 'j'}`;
      const etag = `"${key}"`;
      res.set({ 'Cache-Control': 'public, max-age=2592000, immutable', Vary: 'Accept', ETag: etag });
      if (req.get('if-none-match') === etag) return res.status(304).end();
      let hit = cache.get(key);
      if (!hit) {
        let p = inflight.get(key);
        if (!p) {
          p = render(id, w, webp).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        try { hit = await p; } catch (e) { console.error('[media]', e.message); return res.status(500).end(); }
        if (!hit) return res.status(404).set('Cache-Control', 'no-store').end();
        cache.set(key, hit);
      }
      res.type(hit.type).send(hit.buf);
    });
  }

  return { mount, isClean, analyse };
}

module.exports = { createMedia, analyse };
