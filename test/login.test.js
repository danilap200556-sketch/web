'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, fakeSmsRu, fakeTelegram, loginAs } = require('./helpers');

let shop, sms, tg, ipn = 0;
test.before(async () => {
  sms = await fakeSmsRu();
  tg = await fakeTelegram();
  shop = await startShop('login', {
    SMS_PROVIDER: 'smsru', SMS_API_KEY: 'k', SMS_API_URL: sms.url, TRUST_PROXY: '1', SHOP_NAME: 'SOLEHOUSE',
    TELEGRAM_BOT_TOKEN: '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_URL: tg.url,
  });
});
test.after(async () => { await shop.stop(); await sms.close(); await tg.close(); });

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

// ---------- Telegram ----------
let uid = 5000;
const tgMsg = (from, extra) => ({ update_id: ++uid, message: { message_id: uid, from: { id: from, is_bot: false, first_name: 'Т' }, chat: { id: from, type: 'private' }, date: 0, ...extra } });
const tgStart = (token, from) => tgMsg(from, { text: `/start L${token}` });
const tgContact = (from, phone) => tgMsg(from, { contact: { phone_number: phone, first_name: 'Т', user_id: from } });
const tgSent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage'));
const tgCode = () => /Код для входа: (\d{6})/.exec(tgSent().at(-1).body.text)[1];
async function tgBegin(c, extra = {}) {
  const r = await c.post('/login/telegram/start', { consent: 'on', ...extra }, ip());
  return { r, token: (/data-tg-token="([^"]+)"/.exec(r.text) || [])[1] };
}

test('вход через Telegram: ссылка на бота, контакт, код, сессия, Telegram привязан к клиенту', async () => {
  const c = client(shop.base);
  const { r, token } = await tgBegin(c);
  assert.equal(r.status, 200);
  assert.ok(token);
  assert.ok(r.text.includes(`href="https://t.me/solehouse_test_bot?start=L${token}"`));
  await shop.services.bot.handleUpdate(tgStart(token, 555));
  await shop.services.bot.handleUpdate(tgContact(555, '+79160000302'));
  const code = tgCode();
  const ok = await c.post('/login/telegram/verify', { token, code }, ip());
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/account');
  assert.match((await c.get('/account')).text, /Здравствуйте/);
  const cust = (await shop.db.query("SELECT * FROM webshop.customers WHERE phone = '79160000302'")).rows[0];
  assert.equal(String(cust.telegram_id), '555');
  assert.ok(cust.phone_verified_at);
  // тот же код второй раз не работает, строка входа погашена
  assert.equal((await client(shop.base).post('/login/telegram/verify', { token, code }, ip())).status, 422);
  assert.ok((await shop.db.query('SELECT consumed_at FROM webshop.tg_login WHERE token = $1', [token])).rows[0].consumed_at);
});

test('вход через Telegram: привязанный Telegram получает код без контакта, аккаунт тот же', async () => {
  const c = client(shop.base);
  const { token } = await tgBegin(c, { next: '/checkout' });
  await shop.services.bot.handleUpdate(tgStart(token, 555));                 // 555 уже привязан к 79160000302
  const ok = await c.post('/login/telegram/verify', { token, code: tgCode(), next: '/checkout' }, ip());
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/checkout');
  assert.equal(await customersWith('79160000302'), 1);
});

test('вход через Telegram: без согласия, с неверным кодом и с чужим токеном отказ', async () => {
  const c = client(shop.base);
  const before = (await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.tg_login')).rows[0].n;
  const noConsent = await c.post('/login/telegram/start', {}, ip());
  assert.equal(noConsent.status, 422);
  assert.match(noConsent.text, /согласие/);
  assert.equal((await shop.db.query('SELECT COUNT(*)::int AS n FROM webshop.tg_login')).rows[0].n, before, 'ссылка не создаётся');
  const { token } = await tgBegin(c);
  await shop.services.bot.handleUpdate(tgStart(token, 556));
  await shop.services.bot.handleUpdate(tgContact(556, '+79160000303'));
  const code = tgCode();
  const wrong = await c.post('/login/telegram/verify', { token, code: code === '000000' ? '000001' : '000000' }, ip());
  assert.equal(wrong.status, 422);
  assert.match(wrong.text, /Неверный или просроченный код/);
  assert.ok(wrong.text.includes(`start=L${token}`), 'ссылка на бота остаётся на странице');
  assert.equal((await c.post('/login/telegram/verify', { token: 'чужой-токен', code }, ip())).status, 422);
  assert.equal(await customersWith('79160000303'), 0, 'аккаунт без верного кода не создаётся');
});

test('вход через Telegram: Telegram занят другим аккаунтом - понятная ошибка, входа нет', async () => {
  const { customer: other } = await shop.services.accounts.ensureByVerifiedPhone('79160000304', { name: 'Другой' });
  await shop.services.accounts.bindTelegram(other.id, 777);
  await shop.db.query("INSERT INTO webshop.tg_login (token, purpose, phone, telegram_id, expires_at) VALUES ('tok-conflict-1234567890', 'login', '79160000305', 777, NOW() + INTERVAL '10 minutes')");
  const { code } = await shop.services.codes.issue({ purpose: 'tg', channel: 'tg', target: 'tok-conflict-1234567890' });
  const c = client(shop.base);
  const r = await c.post('/login/telegram/verify', { token: 'tok-conflict-1234567890', code }, ip());
  assert.equal(r.status, 422);
  assert.match(r.text, /уже привязан к другому аккаунту/);
  assert.equal((await c.get('/account')).status, 302);
});

test('вкладки входа: Telegram и SMS, по умолчанию Telegram', async () => {
  const r = await client(shop.base).get('/login');
  assert.match(r.text, /Войти через Telegram|Открыть Telegram/);
  assert.match(r.text, /href="\/login\?tab=sms"/);
  const sms2 = await client(shop.base).get('/login?tab=sms');
  assert.match(sms2.text, /action="\/login\/sms\/send"/);
});
