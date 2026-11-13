'use strict';
// Фон первого экрана главной: своё видео (MP4, WebM) или фото (JPEG, PNG, WebP), загруженное в админке
// («Витрина и каталог»). Хранится одной записью в webshop.hero_media; в настройках - ссылка на неё (heroMedia).
// Видео отдаётся с поддержкой Range: браузеру так можно начать показ, не скачав файл целиком, и перематывать.
const sharp = require('sharp');

const MAX_VIDEO = 60 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;

// Тип файла по первым байтам: расширению и заголовку Content-Type не доверяем
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.toString('latin1', 4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'video', mime: 'video/webm' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image' };
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'image' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image' };
  return null;
}

function createHeroMedia({ db, settings }) {
  let cache = null; // { id, mime, data } - последний отданный файл: видео просят кусками, без кэша каждый кусок шёл бы в базу

  async function save(buf) {
    const t = sniff(buf);
    if (!t) return { error: 'Нужен файл MP4, WebM, JPEG, PNG или WebP' };
    let data = buf;
    let mime = t.mime;
    if (t.kind === 'video') {
      if (buf.length > MAX_VIDEO) return { error: 'Видео больше 60 МБ. Сожмите его: 1080p, 10-20 секунд, без звука - обычно это 5-15 МБ' };
    } else {
      if (buf.length > MAX_IMAGE) return { error: 'Фото больше 25 МБ' };
      // Фото приводим к разумному размеру: на главной оно во всю ширину экрана, больше 2560 px не нужно
      try {
        data = await sharp(buf).rotate().resize({ width: 2560, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      } catch (e) { return { error: 'Не удалось прочитать фото' }; }
      mime = 'image/jpeg';
    }
    const { rows } = await db.query('INSERT INTO webshop.hero_media (kind, mime, data, size) VALUES ($1, $2, $3, $4) RETURNING id', [t.kind, mime, data, data.length]);
    const id = rows[0].id;
    await db.query('DELETE FROM webshop.hero_media WHERE id <> $1', [id]); // хранится только текущий фон
    const meta = { id, kind: t.kind, mime, size: data.length };
    await settings.set({ heroMedia: meta });
    return meta;
  }

  async function remove() {
    await db.query('DELETE FROM webshop.hero_media');
    await settings.set({ heroMedia: null });
    cache = null;
  }

  async function load(id) {
    if (cache && cache.id === id) return cache;
    const { rows } = await db.query('SELECT mime, data FROM webshop.hero_media WHERE id = $1', [id]);
    if (!rows[0]) return null;
    cache = { id, mime: rows[0].mime, data: rows[0].data };
    return cache;
  }

  function mount(app) {
    app.get('/media/hero/:id', async (req, res, next) => {
      try {
        const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
        const f = id ? await load(id) : null;
        if (!f) return res.status(404).type('text').send('not found');
        const total = f.data.length;
        // Номер записи меняется при каждой загрузке, поэтому файл по этому адресу никогда не меняется
        res.set({ 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' });
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '');
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start;
          let end;
          if (m[1] === '') { start = Math.max(0, total - Number(m[2])); end = total - 1; } else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
          if (start >= total || start > end) return res.status(416).set('Content-Range', `bytes */${total}`).end();
          res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) });
          return req.method === 'HEAD' ? res.end() : res.end(f.data.subarray(start, end + 1));
        }
        res.set('Content-Length', String(total));
        return req.method === 'HEAD' ? res.end() : res.end(f.data);
      } catch (e) { next(e); }
    });
  }

  return { save, remove, mount, sniff };
}

module.exports = { createHeroMedia, sniff, MAX_VIDEO };
