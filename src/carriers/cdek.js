'use strict';
// Клиент API СДЭК v2 (https://api-docs.cdek.ru): города, пункты выдачи, расчёт тарифов. Ключи интеграции (Account и Secure password)
// выдаёт личный кабинет СДЭК: «Интеграция» → «Ключи API». Для проверки без боевого договора есть тестовый контур (CDEK_API_URL).
const SUGGEST_TTL = 3600_000;
const POINTS_TTL = 3600_000;
const QUOTE_TTL = 600_000;

class CarrierError extends Error {
  constructor(message, { transient = false } = {}) { super(message); this.transient = transient; }
}

// Тарифы СДЭК по режиму доставки: 1 дверь-дверь, 2 дверь-склад, 3 склад-дверь, 4 склад-склад.
// Откуда отправляем: из офиса СДЭК («office»: магазин сам отвозит посылки) или курьер забирает у магазина («door»).
const MODES = { office: { point: 4, door: 3 }, door: { point: 2, door: 1 } };

function createCdek({ account, secret, baseUrl = 'https://api.cdek.ru', fromCode = 0, fromCity = '', fromMode = 'office', fetchImpl = fetch, timeoutMs = 10_000 }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  let tok = null; // { value, exp }
  let from = fromCode ? Number(fromCode) : 0;
  const caches = { suggest: new Map(), points: new Map(), quote: new Map() };
  const cached = (map, key, ttl, make) => {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = make().catch((e) => { map.delete(key); throw e; });
    map.set(key, { at: Date.now(), p });
    if (map.size > 500) map.delete(map.keys().next().value);
    return p;
  };

  async function raw(path, { method = 'GET', query, form, json, auth = true } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers = { accept: 'application/json' };
    let body;
    if (auth) headers.authorization = `Bearer ${await token()}`;
    if (form) { body = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { body = JSON.stringify(json); headers['content-type'] = 'application/json'; }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new CarrierError(e && e.name === 'TimeoutError' ? 'СДЭК не ответил вовремя' : `СДЭК недоступен (${e.cause && e.cause.code ? e.cause.code : e.message})`, { transient: true });
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
    return { res, data };
  }

  function apiMessage(data, status) {
    const errs = [];
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.message) errs.push(x.message); if (x.error_description) errs.push(x.error_description); for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v); } };
    walk(data);
    return errs.length ? [...new Set(errs)].slice(0, 3).join('; ') : `HTTP ${status}`;
  }

  async function token() {
    if (tok && tok.exp > Date.now() + 60_000) return tok.value;
    const { res, data } = await raw('/v2/oauth/token', { method: 'POST', auth: false, form: { grant_type: 'client_credentials', client_id: account, client_secret: secret } });
    if (!res.ok || !data || !data.access_token) throw new CarrierError(`СДЭК не принял ключи (${apiMessage(data, res.status)})`, { transient: res.status >= 500 });
    tok = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return tok.value;
  }

  async function call(path, opts) {
    let r = await raw(path, opts);
    if (r.res.status === 401) { tok = null; r = await raw(path, opts); }
    if (!r.res.ok) throw new CarrierError(`СДЭК: ${apiMessage(r.data, r.res.status)}`, { transient: r.res.status >= 500 || r.res.status === 429 });
    return r;
  }

  // Подсказка города по началу названия
  function suggestCities(q) {
    const key = String(q).toLowerCase();
    return cached(caches.suggest, key, SUGGEST_TTL, async () => {
      const { data } = await call('/v2/location/suggest/cities', { query: { name: q, country_code: 'RU' } });
      return (Array.isArray(data) ? data : []).slice(0, 10).map((c) => {
        const parts = String(c.full_name || c.city || '').replace(/,\s*Россия\s*$/i, '').split(',').map((x) => x.trim()).filter(Boolean);
        const name = parts[0] || String(c.city || '');
        const region = parts.slice(1).filter((x) => x !== name).join(', ');
        return { code: Number(c.code), name, region };
      }).filter((c) => c.code > 0 && c.name);
    });
  }

  async function fromLocation() {
    if (from) return from;
    if (!fromCity) throw new CarrierError('Не задан город отправления СДЭК (CDEK_FROM_CITY или CDEK_FROM_CODE)');
    const { data } = await call('/v2/location/cities', { query: { country_codes: 'RU', city: fromCity, size: 1 } });
    const c = Array.isArray(data) && data[0];
    if (!c || !c.code) throw new CarrierError(`СДЭК не нашёл город отправления «${fromCity}»`);
    from = Number(c.code);
    return from;
  }

  // Пункты выдачи города (до 1000), с кэшем на час
  function points(cityCode) {
    return cached(caches.points, String(cityCode), POINTS_TTL, async () => {
      const { data } = await call('/v2/deliverypoints', { query: { city_code: cityCode, type: 'PVZ', size: 1000, page: 0 } });
      return (Array.isArray(data) ? data : []).map((p) => {
        const loc = p.location || {};
        return {
          code: String(p.code || ''),
          name: String(p.name || ''),
          address: String(loc.address_full || loc.address || ''),
          hours: String(p.work_time || ''),
          cod: Boolean(p.allowed_cod),
        };
      }).filter((p) => p.code && p.address);
    });
  }

  // Самый дешёвый подходящий тариф. door: до двери или до пункта выдачи. packages: [{weight (г), length, width, height (см)}]
  function tariff({ toCode, door, packages }) {
    const key = JSON.stringify([toCode, !!door, packages]);
    return cached(caches.quote, key, QUOTE_TTL, async () => {
      const fromCodeNow = await fromLocation();
      const want = (MODES[fromMode] || MODES.office)[door ? 'door' : 'point'];
      const { data } = await call('/v2/calculator/tarifflist', {
        method: 'POST',
        json: { type: 1, currency: 0, lang: 'rus', from_location: { code: fromCodeNow }, to_location: { code: Number(toCode) }, packages },
      });
      const list = ((data && data.tariff_codes) || []).filter((t) => Number(t.delivery_mode) === want && Number(t.delivery_sum) > 0);
      if (!list.length) throw new CarrierError('СДЭК не доставляет в этот город выбранным способом', { transient: false });
      list.sort((a, b) => Number(a.delivery_sum) - Number(b.delivery_sum));
      const t = list[0];
      return {
        tariffCode: Number(t.tariff_code),
        tariffName: String(t.tariff_name || ''),
        price: Math.ceil(Number(t.delivery_sum)),
        etaMin: Number(t.calendar_min ?? t.period_min) || 0,
        etaMax: Number(t.calendar_max ?? t.period_max) || 0,
      };
    });
  }

  // Проверка подключения для админки: ключи, город отправления, подсказка города, тестовый тариф
  async function check() {
    const steps = [];
    const run = async (title, fn) => { try { steps.push({ title, ok: true, info: await fn() }); return true; } catch (e) { steps.push({ title, ok: false, info: e.message }); return false; } };
    if (!await run('Ключи интеграции (получение токена)', async () => { tok = null; await token(); return 'токен получен'; })) return steps;
    await run('Город отправления', async () => `код ${await fromLocation()}`);
    let spb = 0;
    await run('Подсказка города («Санкт»)', async () => { const r = await suggestCities('Санкт'); spb = (r[0] || {}).code || 0; return r.length ? `${r[0].name}, код ${r[0].code}` : 'ничего не найдено'; });
    if (spb) {
      await run('Расчёт тарифа до пункта выдачи (1 кг)', async () => { const t = await tariff({ toCode: spb, door: false, packages: [{ weight: 1000, length: 30, width: 20, height: 10 }] }); return `${t.tariffName || 'тариф ' + t.tariffCode}: ${t.price} ₽, ${t.etaMin}-${t.etaMax} дн.`; });
      await run('Список пунктов выдачи', async () => { const p = await points(spb); return `найдено: ${p.length}`; });
    }
    return steps;
  }

  return { code: 'cdek', title: 'СДЭК', suggestCities, points, tariff, check, fromMode };
}

module.exports = { createCdek, CarrierError };
