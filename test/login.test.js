'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, fakeSmsRu, loginAs } = require('./helpers');

let shop, sms, ipn = 0;
test.before(async () => {
  sms = await fakeSmsRu();
  shop = await startShop('login', { SMS_PROVIDER: 'smsru', SMS_API_KEY: 'k', SMS_API_URL: sms.url, TRUST_PROXY: '1', SHOP_NAME: 'SOLEHOUSE' });
});
test.after(async () => { await shop.stop(); await sms.close(); });

// Каждый запрос с «своим» адресом: лимит отправок на IP не мешает тестам друг другу
const ip = () => ({ headers: { 'x-forwarded-for': `10.0.0.${++ipn}` } });
const lastCode = () => /(\d{6})/.exec(sms.calls.at(-1).msg)[1];
async function smsLogin(c, phone, { phoneAgain = phone, next = '', consent = 'on' } = {}) {
  const h = ip();
  const r1 = await c.post('/login/sms/send', { phone, consent, next }, h);
  if (r1.status !== 200) return r1;
  return c.post('/login/sms/verify', { phone: phoneAgain, code: lastCode(), next }, h);
}
const customersWith = async (phone) => (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.customers WHERE phone = $1', [phone])).rows[0].n;

test('вход по SMS: номер в любом написании, один аккаунт, кабинет открывается', async () => {
  const c = client(shop.base);
  const r1 = await c.post('/login/sms/send', { phone: '8 (916) 000-01-01', consent: 'on' }, ip());
  assert.equal(r1.status, 200);
  assert.equal(sms.calls.length, 1);
  assert.equal(sms.calls[0].to, '79160000101');
  assert.match(sms.calls[0].msg, /^\d{6} /);
  const r2 = await c.post('/login/sms/verify', { phone: '+7 916 000 01 01', code: lastCode() }, ip());   // другое написание того же номера
  assert.equal(r2.status, 302);
  assert.equal(r2.location, '/account');
  assert.match((await c.get('/account')).text, /Здравствуйте/);
  assert.equal(await customersWith('79160000101'), 1);
  // третий вход тем же номером в третьем написании (минута прошла): тот же аккаунт
  await shop.db.query("UPDATE webshop.auth_codes SET created_at = created_at - INTERVAL '2 minutes' WHERE target = '79160000101'");
  const c2 = client(shop.base);
  const r3 = await smsLogin(c2, '916-000-01-01');
  assert.equal(r3.status, 302);
  assert.equal(await customersWith('79160000101'), 1);
});

test('вход по SMS: без согласия, с неверным номером и неверным кодом отказ', async () => {
  const c = client(shop.base);
  const n = sms.calls.length;
  const noConsent = await c.post('/login/sms/send', { phone: '+7 916 000 01 02' }, ip());
  assert.equal(noConsent.status, 422);
  assert.match(noConsent.text, /согласие/);
  const badPhone = await c.post('/login/sms/send', { phone: '12345', consent: 'on' }, ip());
  assert.equal(badPhone.status, 422);
  assert.equal(sms.calls.length, n, 'SMS не уходит');
  await c.post('/login/sms/send', { phone: '+7 916 000 01 02', consent: 'on' }, ip());
  const wrong = await c.post('/login/sms/verify', { phone: '+7 916 000 01 02', code: lastCode() === '000000' ? '000001' : '000000' }, ip());
  assert.equal(wrong.status, 422);
  assert.match(wrong.text, /Неверный или просроченный код/);
  assert.equal((await c.get('/account')).status, 302);
  assert.equal(await customersWith('79160000102'), 0, 'аккаунт без подтверждения не создаётся');
});

test('вход по SMS: частые отправки на один номер получают 429, провайдер недоступен - понятная ошибка', async () => {
  const c = client(shop.base);
  assert.equal((await c.post('/login/sms/send', { phone: '+7 916 000 01 03', consent: 'on' }, ip())).status, 200);
  const again = await c.post('/login/sms/send', { phone: '+7 916 000 01 03', consent: 'on' }, ip());
  assert.equal(again.status, 429);
  assert.match(again.text, /Слишком часто/);
  sms.mode.fail = true;
  const down = await c.post('/login/sms/send', { phone: '+7 916 000 01 04', consent: 'on' }, ip());
  sms.mode.fail = false;
  assert.equal(down.status, 502);
  assert.match(down.text, /Не удалось отправить SMS/);
});

test('переход после входа: свой путь можно, чужой адрес нет', async () => {
  const a = await smsLogin(client(shop.base), '+7 916 000 01 05', { next: '/checkout' });
  assert.equal(a.location, '/checkout');
  const b = await smsLogin(client(shop.base), '+7 916 000 01 06', { next: '//evil.example/x' });
  assert.equal(b.location, '/account');
  const c = await smsLogin(client(shop.base), '+7 916 000 01 07', { next: 'https://evil.example/' });
  assert.equal(c.location, '/account');
});

test('выход и подделанная cookie', async () => {
  const c = client(shop.base);
  await loginAs(shop, c, '79160000111');
  assert.equal((await c.get('/account')).status, 200);
  const out = await c.post('/account/logout', {});
  assert.equal(out.status, 302);
  assert.equal((await c.get('/account')).status, 302);
  const forged = client(shop.base);
  forged.jar.set(shop.services.sessions.cookieName, 'forged-cookie-value');
  const r = await forged.get('/account');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);
});

test('страницы аккаунта: no-store, noindex, закрыты в robots.txt; вошедшего с /login уводит в кабинет', async () => {
  const c = client(shop.base);
  const login = await c.get('/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('cache-control'), /no-store/);
  assert.match(login.text, /name="robots" content="noindex/);
  const robots = (await c.get('/robots.txt')).text;
  assert.match(robots, /Disallow: \/account/);
  assert.match(robots, /Disallow: \/login/);
  await loginAs(shop, c, '79160000112');
  const r = await c.get('/login');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/account');
});

test('в шапке витрины ссылка «Войти» или «Кабинет»', async () => {
  const guest = client(shop.base);
  assert.match((await guest.get('/')).text, /href="\/login"[^>]*aria-label="Войти"/);
  const c = client(shop.base);
  await loginAs(shop, c, '79160000113');
  assert.match((await c.get('/')).text, /href="\/account"[^>]*aria-label="Личный кабинет"/);
});

test('страница /privacy открывается без входа', async () => {
  const r = await client(shop.base).get('/privacy');
  assert.equal(r.status, 200);
  assert.match(r.text, /персональных данных/);
});

test('без SMS и бота вход выключен: страницы нет, ссылки в шапке нет', async () => {
  const off = await startShop('login_off');
  try {
    const c = client(off.base);
    assert.equal((await c.get('/login')).status, 404);
    assert.equal((await c.post('/login/sms/send', { phone: '+7 916 000 02 01', consent: 'on' })).status, 404);
    assert.ok(!/href="\/login"/.test((await c.get('/')).text));
  } finally { await off.stop(); }
});
