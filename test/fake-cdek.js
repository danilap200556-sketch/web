'use strict';
const http = require('node:http');

// Поддельный СДЭК API v2 с теми же путями и форматами ответов, что в документации. Проверяет ключи и токен.
async function fakeCdek() {
  const st = { calls: [], tokens: 0, expireNext: false, tariffFail: 0, noTariff: false, validToken: null };
  const POINTS = {
    44: [
      { code: 'MSK1', name: 'Пункт на Тверской', location: { address_full: 'Москва, ул. Тверская, 7' }, work_time: 'Пн-Вс 10:00-21:00', allowed_cod: true },
      { code: 'MSK2', name: 'Пункт у метро Сокол', location: { address: 'Москва, Ленинградский пр-т, 70' }, work_time: 'Пн-Пт 9:00-20:00' },
      { code: 'MSK3', name: 'Без адреса', location: {} },
    ],
    137: [{ code: 'SPB1', name: 'Невский', location: { address_full: 'Санкт-Петербург, Невский пр-т, 1' }, work_time: '10-20' }],
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      st.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || '' });
      const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/v2/oauth/token') {
        const f = new URLSearchParams(raw);
        if (f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== 'acc' || f.get('client_secret') !== 'sec') return send(401, { error: 'invalid_client', error_description: 'Неверные ключи' });
        st.tokens++;
        st.validToken = `tok-${st.tokens}`;
        return send(200, { access_token: st.validToken, token_type: 'Bearer', expires_in: 3599 });
      }
      if (st.expireNext && req.headers.authorization) { st.expireNext = false; st.validToken = null; }
      if (req.headers.authorization !== `Bearer ${st.validToken}`) return send(401, { requests: [{ errors: [{ code: 'v2_token_expired', message: 'Token expired' }] }] });
      if (url.pathname === '/v2/location/suggest/cities') {
        const n = (url.searchParams.get('name') || '').toLowerCase();
        const all = [{ city_uuid: 'a', code: 44, full_name: 'Москва, Москва, Россия' }, { city_uuid: 'b', code: 137, full_name: 'Санкт-Петербург, Санкт-Петербург, Россия' }, { city_uuid: 'c', code: 250, full_name: 'Сызрань, Самарская область, Россия' }];
        return send(200, all.filter((c) => c.full_name.toLowerCase().startsWith(n)));
      }
      if (url.pathname === '/v2/location/cities') return send(200, [{ code: 44, city: url.searchParams.get('city') }]);
      if (url.pathname === '/v2/deliverypoints') return send(200, POINTS[url.searchParams.get('city_code')] || []);
      if (url.pathname === '/v2/calculator/tarifflist') {
        if (st.tariffFail > 0) { st.tariffFail--; return send(500, { error: 'internal' }); }
        const b = JSON.parse(raw);
        st.lastTariffBody = b;
        if (st.noTariff) return send(200, { tariff_codes: [], errors: [{ code: 'ERR_NO_TARIFF', message: 'Нет доступных тарифов' }] });
        const kg = Math.ceil(b.packages[0].weight / 1000);
        const base = 200 + kg * 50 + (b.to_location.code === 44 ? 0 : 150);
        return send(200, { tariff_codes: [
          { tariff_code: 139, tariff_name: 'Посылка дверь-дверь', delivery_mode: 1, delivery_sum: base + 400, period_min: 2, period_max: 3, calendar_min: 2, calendar_max: 4 },
          { tariff_code: 138, tariff_name: 'Посылка дверь-склад', delivery_mode: 2, delivery_sum: base + 100, period_min: 2, period_max: 3, calendar_min: 2, calendar_max: 4 },
          { tariff_code: 137, tariff_name: 'Посылка склад-дверь', delivery_mode: 3, delivery_sum: base + 150.4, period_min: 2, period_max: 3, calendar_min: 2, calendar_max: 4 },
          { tariff_code: 483, tariff_name: 'Экспресс склад-склад', delivery_mode: 4, delivery_sum: base + 300, period_min: 1, period_max: 1, calendar_min: 1, calendar_max: 2 },
          { tariff_code: 136, tariff_name: 'Посылка склад-склад', delivery_mode: 4, delivery_sum: base, period_min: 2, period_max: 4, calendar_min: 3, calendar_max: 5 },
        ] });
      }
      return send(404, { error: 'unknown' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { fakeCdek };
