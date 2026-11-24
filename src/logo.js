'use strict';
// Логотип сайта, загруженный в админке («Витрина и каталог» → «Логотип»). Без своего файла на сайте стоит логотип по умолчанию
// из public/img (logo-ks-*.svg). Хранится одной записью в webshop.site_logo; в настройках - ссылка на неё (logo).
//
// Из одного файла готовятся три PNG:
//   dark  - для светлого фона (страницы, админка), light - для тёмного (шапка, подвал), icon - квадратный значок вкладки 180 px.
// «Одноцветный» логотип (по умолчанию): фон по углам картинки убирается, знаки красятся в чёрный и в белый - так один файл
// хорошо смотрится и на белом, и на чёрном. Цветной логотип показывается как есть (ровный фон по углам тоже убирается).
const sharp = require('sharp');

const MAX = 10 * 1024 * 1024;
const H = 240; // высота готовых вариантов: на сайте логотип до 60 px, запас на экраны с плотными пикселями

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return true;
  return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

// Фон по четырём углам: прозрачный, ровного цвета или «нет ровного фона» (фото)
function cornerBackground(px, w, h) {
  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };
  const k = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const pts = [at(k, k), at(w - 1 - k, k), at(k, h - 1 - k), at(w - 1 - k, h - 1 - k)];
  if (pts.every((p) => p[3] < 16)) return { kind: 'transparent' };
  if (pts.some((p) => p[3] < 240)) return { kind: 'none' };
  const avg = [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / 4);
  const flat = pts.every((p) => Math.max(...[0, 1, 2].map((c) => Math.abs(p[c] - avg[c]))) < 24);
  return flat ? { kind: 'color', rgb: avg } : { kind: 'none' };
}

// Прозрачность каждой точки: насколько она отличается от фона (мягкий порог - без «лесенки» по краю)
function alphaMask(px, bg) {
  const n = px.length / 4;
  const a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (bg.kind === 'color') {
      const d = Math.max(Math.abs(px[o] - bg.rgb[0]), Math.abs(px[o + 1] - bg.rgb[1]), Math.abs(px[o + 2] - bg.rgb[2]));
      a[i] = Math.round(Math.min(1, Math.max(0, (d - 24) / 72)) * (px[o + 3] / 255) * 255);
    } else a[i] = px[o + 3];
  }
  return a;
}

async function buildVariants(buf, mono) {
  const img = sharp(buf, { limitInputPixels: 40_000_000 }).rotate().ensureAlpha();
  const meta0 = await sharp(buf).metadata();
  if (!meta0.width || !meta0.height) throw new Error('bad');
  const { data: px, info } = await img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const bg = cornerBackground(px, w, h);
  const knock = bg.kind !== 'none';
  const mask = knock ? alphaMask(px, bg) : null;
  const paint = (rgb) => {
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      out[o] = rgb ? rgb[0] : px[o]; out[o + 1] = rgb ? rgb[1] : px[o + 1]; out[o + 2] = rgb ? rgb[2] : px[o + 2];
      out[o + 3] = mask ? mask[i] : px[o + 3];
    }
    return sharp(out, { raw: { width: w, height: h, channels: 4 } });
  };
  // обрезаем пустые поля по маске, чтобы логотип стоял ровно по высоте строки
  const base = await (mono && knock ? paint([11, 11, 11]) : paint(null)).png().toBuffer();
  let box = { left: 0, top: 0, width: w, height: h };
  if (knock) {
    const t = await sharp(base).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true }).catch(() => null);
    if (t && t.info.width > 4 && t.info.height > 4) box = { left: -t.info.trimOffsetLeft, top: -t.info.trimOffsetTop, width: t.info.width, height: t.info.height };
  }
  const variant = async (rgb) => (await (mono && knock ? paint(rgb) : paint(null)).png().toBuffer());
  const fit = (b) => sharp(b).extract(box).resize({ height: H, width: H * 4, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  const dark = await fit(await variant([11, 11, 11]));
  const light = await fit(await variant([255, 255, 255]));
  const dm = await sharp(dark).metadata();
  // значок: исходник целиком на квадрате его же цвета фона
  const iconBg = bg.kind === 'color' ? { r: Math.round(bg.rgb[0]), g: Math.round(bg.rgb[1]), b: Math.round(bg.rgb[2]), alpha: 1 } : { r: 11, g: 11, b: 11, alpha: 1 };
  const iconSrc = bg.kind === 'color' ? await sharp(buf).rotate().png().toBuffer() : light;
  const icon = await sharp(iconSrc).resize(152, 152, { fit: 'contain', background: iconBg }).extend({ top: 14, bottom: 14, left: 14, right: 14, background: iconBg })
    .flatten({ background: iconBg }).png({ compressionLevel: 9 }).toBuffer();
  const original = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return { original, dark, light, icon, width: dm.width, height: dm.height, knock };
}

function createLogo({ db, settings }) {
  const cache = new Map(); // `${id}/${variant}` -> Buffer

  async function save(buf, { mono = true } = {}) {
    if (!sniff(buf)) return { error: 'Нужен файл PNG, JPEG или WebP' };
    if (buf.length > MAX) return { error: 'Файл больше 10 МБ' };
    let r;
    try { r = await buildVariants(buf, mono); } catch (e) { return { error: 'Не удалось прочитать картинку' }; }
    const { rows } = await db.query(
      'INSERT INTO webshop.site_logo (mono, original, dark, light, icon, width, height) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [mono, r.original, r.dark, r.light, r.icon, r.width, r.height]);
    const id = rows[0].id;
    await db.query('DELETE FROM webshop.site_logo WHERE id <> $1', [id]); // хранится только текущий логотип
    const meta = { id, mono, w: r.width, h: r.height, knock: r.knock };
    await settings.set({ logo: meta });
    return meta;
  }

  async function remove() {
    await db.query('DELETE FROM webshop.site_logo');
    await settings.set({ logo: null });
    cache.clear();
  }

  function mount(app) {
    app.get('/media/logo/:id/:variant.png', async (req, res, next) => {
      try {
        const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
        const v = req.params.variant;
        if (!id || !['dark', 'light', 'icon', 'original'].includes(v)) return res.status(404).type('text').send('not found');
        const key = `${id}/${v}`;
        let data = cache.get(key);
        if (!data) {
          const { rows } = await db.query(`SELECT ${v} AS data FROM webshop.site_logo WHERE id = $1`, [id]);
          if (!rows[0]) return res.status(404).type('text').send('not found');
          data = rows[0].data;
          if (cache.size > 16) cache.clear();
          cache.set(key, data);
        }
        // номер записи меняется при каждой загрузке: файл по адресу никогда не меняется
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(data);
      } catch (e) { next(e); }
    });
  }

  return { save, remove, mount };
}

// Адреса картинок логотипа для страниц: свой из админки или логотип по умолчанию
function logoUrls(s) {
  const l = s && s.logo && s.logo.id ? s.logo : null;
  if (!l) return { dark: '/static/img/logo-ks-dark.svg', light: '/static/img/logo-ks-light.svg', icon: '/static/favicon.svg', w: 940, h: 830, custom: false };
  return { dark: `/media/logo/${l.id}/dark.png`, light: `/media/logo/${l.id}/light.png`, icon: `/media/logo/${l.id}/icon.png`, w: l.w, h: l.h, custom: true };
}

module.exports = { createLogo, logoUrls, sniff };
