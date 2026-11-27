'use strict';
// Кэш готовых фото на диске. Обработка фото (студийный вид) и скачивание картинок партнёров - самое дорогое, что делает сайт: после каждого
// перезапуска или обновления память пустеет, и первые посетители ждали бы обработки десятков фото на каждой странице. Здесь готовые файлы
// (и скачанные оригиналы партнёров) лежат в папке, которая переживает обновление сайта (в docker - отдельный том).
//
// Размер ограничен: когда папка вырастает больше maxBytes, самые давние по использованию файлы удаляются (до 80% лимита).
// Без папки (MEDIA_CACHE_DIR не задан) или если в неё нельзя писать, кэш молча выключен и сайт работает как раньше.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE = /^[A-Za-z0-9._-]{1,160}$/;   // имена файлов строим сами, но на всякий случай не пускаем ни путей, ни странных символов

function createDiskCache({ dir = '', maxBytes = 1024 * 1024 * 1024, pruneEveryMs = 3600_000, log = console } = {}) {
  let ok = false;
  let timer = null;
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); ok = true; }
    catch (e) { log.warn(`[media] кэш фото на диске выключен: ${e.message}`); }
  }
  const fileOf = (key) => (SAFE.test(String(key)) && !String(key).includes('..') ? path.join(dir, String(key)) : null);

  async function get(key) {
    const f = ok ? fileOf(key) : null;
    if (!f) return null;
    try {
      const buf = await fs.promises.readFile(f);
      const now = new Date();
      fs.promises.utimes(f, now, now).catch(() => {});      // «использован»: давно не нужные файлы удаляются первыми
      return buf.length ? buf : null;
    } catch { return null; }
  }

  // Файл пишется во временный и переименовывается: недописанный файл никто не прочитает
  async function set(key, buf) {
    const f = ok && buf && buf.length ? fileOf(key) : null;
    if (!f) return false;
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try { await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, f); return true; }
    catch (e) { fs.promises.unlink(tmp).catch(() => {}); log.warn(`[media] не записал фото в кэш на диске: ${e.message}`); return false; }
  }

  async function prune() {
    if (!ok) return { removed: 0, bytes: 0 };
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return { removed: 0, bytes: 0 }; }
    const files = [];
    for (const name of names) {
      try {
        const f = path.join(dir, name);
        const st = await fs.promises.stat(f);
        if (!st.isFile()) continue;
        if (name.endsWith('.tmp')) { if (Date.now() - st.mtimeMs > 3600_000) await fs.promises.unlink(f).catch(() => {}); continue; }   // брошенные недописанные файлы
        files.push({ f, size: st.size, at: st.mtimeMs });
      } catch { /* файл исчез: пропускаем */ }
    }
    let total = files.reduce((a, x) => a + x.size, 0);
    let removed = 0;
    if (total > maxBytes) {
      files.sort((a, b) => a.at - b.at);
      for (const x of files) {
        if (total <= maxBytes * 0.8) break;
        await fs.promises.unlink(x.f).then(() => { total -= x.size; removed++; }).catch(() => {});
      }
    }
    return { removed, bytes: total };
  }

  function start() {
    if (!ok || timer) return;
    timer = setInterval(() => { prune().catch(() => {}); }, pruneEveryMs);
    timer.unref();
    const first = setTimeout(() => { prune().catch(() => {}); }, 30_000);
    first.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { enabled: () => ok, get, set, prune, start, stop, dir };
}

module.exports = { createDiskCache };
