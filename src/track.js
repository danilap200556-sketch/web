'use strict';
// Статистика посещений без сторонних счётчиков: свои cookie vid (посетитель, год) и sid (визит, 30 минут без активности).
// Записи копятся в памяти и пишутся в базу пачкой раз в 3 секунды: страница не ждёт удалённую базу.
const { randomId } = require('./security');

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|headless|lighthouse|pingdom|uptime|python-requests|curl\/|wget|go-http|axios|node-fetch|okhttp|java\//i;
const SEARCH = /(^|\.)(google|yandex|bing|duckduckgo|mail|rambler|ya)\./i;
const SOCIAL = /(^|\.)(vk\.com|t\.me|telegram|instagram|facebook|ok\.ru|youtube|tiktok|pinterest|twitter|x\.com|dzen)/i;

const isBot = (ua) => !ua || BOT_RE.test(ua);
function device(ua) {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Откуда пришёл посетитель: utm_source, иначе по адресу страницы-источника
function sourceOf(req) {
  const utm = String(req.query.utm_source || '').toLowerCase().replace(/[^a-z0-9а-я._-]/g, '').slice(0, 40);
  let host = '';
  try { host = new URL(req.get('referer') || '').hostname.replace(/^www\./, ''); } catch { /* нет источника */ }
  if (host && host === String(req.hostname).replace(/^www\./, '')) host = '';
  let source = 'direct';
  if (utm) source = utm;
  else if (host) source = SEARCH.test(host) ? 'search' : SOCIAL.test(host) ? 'social' : 'referral';
  return { host: host.slice(0, 80), source };
}

function createTracker(db, cfg) {
  let buf = [];
  let timer = null;
  const cookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, path: '/', ...(maxAge ? { maxAge } : {}) });
  const vidName = cfg.secureCookies ? '__Host-vid' : 'vid';
  const sidName = cfg.secureCookies ? '__Host-sid' : 'sid';

  async function flush() {
    if (!buf.length) return;
    const rows = buf;
    buf = [];
    const params = [];
    const values = rows.map((r, i) => {
      params.push(r.at, r.kind, r.vid, r.sid, r.path, r.model_key, r.ref_host, r.source, r.device);
      const o = i * 9;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
    });
    try {
      await db.query(`INSERT INTO webshop.visits (at, kind, vid, sid, path, model_key, ref_host, source, device) VALUES ${values.join(',')}`, params);
    } catch (e) {
      console.error('[track] не записалось, отбрасываю', rows.length, 'шт.:', e.message);
    }
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, 3000);
    timer.unref();
  }

  // Определяет посетителя/визит (и ставит cookie), записывает событие. Для ботов и служебных запросов ничего не делает.
  function record(req, res, kind, extra = {}) {
    const ua = req.get('user-agent') || '';
    if (isBot(ua)) return { vid: '', sid: '', source: '' };
    let vid = req.cookies[vidName];
    let sid = req.cookies[sidName];
    if (!vid || vid.length > 40) { vid = randomId(10); res.cookie(vidName, vid, cookieOpts(365 * 86400_000)); }
    const newVisit = !sid || sid.length > 40;
    if (newVisit) sid = randomId(10);
    // Скользящие 30 минут: продлеваем при каждом просмотре страницы
    if (kind === 'page' || newVisit) res.cookie(sidName, sid, cookieOpts(30 * 60_000));
    const src = sourceOf(req);
    // Источник считаем только у первого просмотра визита; дальше - из той же сессии (в БД ищется по первой записи визита)
    buf.push({
      at: new Date(), kind, vid, sid,
      path: String(extra.path ?? req.path).slice(0, 200),
      model_key: String(extra.model_key || '').slice(0, 100),
      ref_host: newVisit ? src.host : '',
      source: newVisit ? src.source : '',
      device: device(ua),
    });
    schedule();
    if (buf.length >= 200) flush();
    return { vid, sid, source: newVisit ? src.source : '' };
  }

  // Для оформления заказа: кто это (без записи просмотра)
  function who(req) {
    return { vid: req.cookies[vidName] || '', sid: req.cookies[sidName] || '' };
  }

  return { record, who, flush, vidName, sidName };
}

module.exports = { createTracker, isBot, device, sourceOf };
