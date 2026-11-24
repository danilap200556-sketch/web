'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const { startShop, client, fakeSmsRu, fakeTelegram, loginAs } = require('./helpers');

const mailbox = [];
const mailReal = nodemailer.createTransport({ jsonTransport: true });
const mailTransport = { sendMail: async (m) => { const info = await mailReal.sendMail(m); mailbox.push(JSON.parse(info.message)); return info; } };
const waitMail = async (n) => { for (let i = 0; i < 60 && mailbox.length < n; i++) await new Promise((r) => setTimeout(r, 25)); return mailbox.at(-1); };
let shop, sms, tg, ipn = 0;
test.before(async () => {
  sms = await fakeSmsRu();
  tg = await fakeTelegram();
  shop = await startShop('login', {
    SMS_PROVIDER: 'smsru', SMS_API_KEY: 'k', SMS_API_URL: sms.url, TRUST_PROXY: '1', SHOP_NAME: 'SOLEHOUSE',
    TELEGRAM_BOT_TOKEN: '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_URL: tg.url,
    SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'SOLEHOUSE <shop@test.ru>', PUBLIC_URL: 'https://shop.test',
  }, { app: { mailTransport } });
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
  assert.equal(r2.location, '/account/welcome');     // новый аккаунт: предлагаем задать пароль и почту
  assert.match((await c.get('/account')).text, /Здравствуйте/);
  assert.equal(await customersWith('79160000101'), 1);
  // третий вход тем же номером в третьем написании (минута прошла): тот же аккаунт
  await shop.db.query("UPDATE webshop.auth_codes SET created_at = created_at - INTERVAL '2 minutes' WHERE target = '79160000101'");
  const c2 = client(shop.base);
  const r3 = await smsLogin(c2, '916-000-01-01');
  assert.equal(r3.status, 302);
  assert.equal(r3.location, '/account', 'не новый аккаунт: сразу в кабинет');
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
  assert.equal(b.location, '/account/welcome');
  const c = await smsLogin(client(shop.base), '+7 916 000 01 07', { next: 'https://evil.example/' });
  assert.equal(c.location, '/account/welcome');
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
  assert.equal(ok.location, '/account/welcome');
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

// ---------- Пароль, «Забыли пароль», профиль ----------
async function accountWithPassword(phone, { email = '', password = 'password-1', verified = false } = {}) {
  const { accounts } = shop.services;
  const { customer } = await accounts.ensureByVerifiedPhone(phone, { name: 'Покупатель' });
  if (email) await accounts.setProfile(customer.id, { name: 'Покупатель', email });
  await accounts.setPassword(customer.id, password);
  if (verified) await accounts.markEmailVerified(customer.id);
  return customer;
}
const pwLogin = (c, login, password, extra = {}) => c.post('/login/password', { login, password, ...extra }, ip());

test('вход по паролю: телефон и почта в любом регистре, обычная (не свежая) сессия', async () => {
  const cust = await accountWithPassword('79160000401', { email: 'Buyer401@Example.ru' });
  const a = client(shop.base);
  const r1 = await pwLogin(a, '8 916 000-04-01', 'password-1', { next: '/checkout' });
  assert.equal(r1.status, 302);
  assert.equal(r1.location, '/checkout');
  const b = client(shop.base);
  const r2 = await pwLogin(b, ' buyer401@example.RU ', 'password-1');
  assert.equal(r2.location, '/account');
  assert.match((await b.get('/account')).text, /Здравствуйте/);
  const sess = (await shop.db.query('SELECT fresh_until FROM webshop.customer_sessions WHERE customer_id = $1 ORDER BY id DESC LIMIT 1', [cust.id])).rows[0];
  assert.equal(sess.fresh_until, null);
});

test('вход по паролю: одинаковая ошибка для неизвестного и неверного, после пяти неудач блокировка', async () => {
  await accountWithPassword('79160000402');
  const c = client(shop.base);
  const wrong = await pwLogin(c, '79160000402', 'не-тот-пароль');
  const unknown = await pwLogin(c, '79160000499', 'не-тот-пароль');
  assert.equal(wrong.status, 422);
  assert.equal(unknown.status, 422);
  assert.match(wrong.text, /Неверный логин или пароль/);
  assert.match(unknown.text, /Неверный логин или пароль/);
  for (let i = 0; i < 4; i++) await pwLogin(c, '79160000402', 'не-тот-пароль');
  const blocked = await pwLogin(c, '79160000402', 'password-1');                    // верный пароль, но попыток уже слишком много
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Слишком много попыток/);
  assert.equal((await c.get('/account')).status, 302);
});

test('«Забыли пароль»: страница с каналами, неизвестный адресат получает тот же ответ и ничего не отправляется', async () => {
  const c = client(shop.base);
  const page = await c.get('/login/forgot');
  assert.equal(page.status, 200);
  assert.match(page.text, /tab=tg&amp;next=%2Faccount%2Fpassword/);
  assert.match(page.text, /tab=sms&amp;next=%2Faccount%2Fpassword/);
  assert.match(page.text, /action="\/login\/forgot\/mail"/);
  const mails = mailbox.length;
  const smsN = sms.calls.length;
  const unknown = await c.post('/login/forgot/mail', { login: 'nobody@example.ru' }, ip());
  await accountWithPassword('79160000403', { email: 'unverified403@example.ru', verified: false });
  const unverified = await c.post('/login/forgot/mail', { login: 'unverified403@example.ru' }, ip());
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(unknown.status, 200);
  assert.equal(unverified.status, 200);
  assert.match(unknown.text, /Если такой аккаунт есть/);
  assert.equal(unknown.text.replace(/\s+/g, ' ').replace(/value="[^"]*"/g, ''), unverified.text.replace(/\s+/g, ' ').replace(/value="[^"]*"/g, ''), 'ответы совпадают');
  assert.equal(mailbox.length, mails, 'письмо не уходит');
  assert.equal(sms.calls.length, smsN);
});

test('сброс пароля по ссылке: письмо, ссылка не гасится от просмотра, один раз, затем новый пароль без старого', async () => {
  const cust = await accountWithPassword('79160000404', { email: 'reset404@example.ru', verified: true });
  const other = client(shop.base);
  await pwLogin(other, '79160000404', 'password-1');                                // сессия на другом устройстве
  const c = client(shop.base);
  const before = mailbox.length;
  assert.equal((await c.post('/login/forgot/mail', { login: '+7 916 000-04-04' }, ip())).status, 200);   // по номеру, письмо на почту аккаунта
  const mail = await waitMail(before + 1);
  assert.equal(mail.to[0].address, 'reset404@example.ru');
  const link = /https:\/\/shop\.test(\/login\/reset\/[\w-]+)/.exec(mail.text)[1];
  const view = await c.get(link);
  assert.equal(view.status, 200);
  assert.match(view.text, /action="\/login\/reset"/);
  assert.equal((await c.get(link)).status, 200, 'просмотр не гасит ссылку');
  const token = /name="token" value="([^"]+)"/.exec(view.text)[1];
  const used = await c.post('/login/reset', { token }, ip());
  assert.equal(used.status, 302);
  assert.equal(used.location, '/account/password');
  assert.equal((await client(shop.base).post('/login/reset', { token }, ip())).status, 422, 'ссылка одноразовая');
  // свежая сессия: старый пароль не нужен
  const form = await c.get('/account/password');
  assert.doesNotMatch(form.text, /name="old"/);
  const set = await c.post('/account/password', { password: 'new-password-2', password2: 'new-password-2' }, ip());
  assert.equal(set.status, 302);
  assert.equal((await other.get('/account')).status, 302, 'сессия на другом устройстве закрыта');
  assert.equal((await c.get('/account')).status, 200, 'текущая жива');
  assert.equal((await pwLogin(client(shop.base), '79160000404', 'new-password-2')).status, 302);
  assert.equal((await pwLogin(client(shop.base), '79160000404', 'password-1')).status, 422);
});

test('смена пароля из обычной сессии: нужен старый, слабый и несовпадающий отклоняются', async () => {
  await accountWithPassword('79160000405');
  const c = client(shop.base);
  await pwLogin(c, '79160000405', 'password-1');
  assert.match((await c.get('/account/password')).text, /name="old"/);
  const bad = (form) => c.post('/account/password', form, ip());
  assert.equal((await bad({ old: 'wrong-old-1', password: 'new-password-3', password2: 'new-password-3' })).status, 422);
  assert.match((await bad({ old: 'password-1', password: '123', password2: '123' })).text, /не короче 8/);
  assert.match((await bad({ old: 'password-1', password: 'new-password-3', password2: 'другой-пароль-4' })).text, /не совпадают/);
  const ok = await bad({ old: 'password-1', password: 'new-password-3', password2: 'new-password-3' });
  assert.equal(ok.status, 302);
  assert.equal((await pwLogin(client(shop.base), '79160000405', 'new-password-3')).status, 302);
});

test('профиль: имя и почта, занятая почта и неверный адрес отклоняются, письмо подтверждения и ссылка', async () => {
  await accountWithPassword('79160000406', { email: 'taken406@example.ru' });
  const c = client(shop.base);
  const cust = await loginAs(shop, c, '79160000407', { name: 'Старое имя' });
  assert.match((await c.get('/account/profile')).text, /Старое имя/);
  assert.equal((await c.post('/account/profile', { name: 'Новое имя', email: 'не почта' }, ip())).status, 422);
  const mails = mailbox.length;
  const ok = await c.post('/account/profile', { name: 'Новое имя', email: 'mine407@example.ru' }, ip());
  assert.equal(ok.status, 302);
  const row = (await shop.db.query('SELECT name, email, email_verified_at FROM webshop.customers WHERE id = $1', [cust.id])).rows[0];
  assert.equal(row.name, 'Новое имя');
  assert.equal(row.email, 'mine407@example.ru');
  assert.equal(row.email_verified_at, null);
  const mail = await waitMail(mails + 1);
  assert.equal(mail.to[0].address, 'mine407@example.ru');
  const link = /https:\/\/shop\.test(\/login\/verify-email\/[\w-]+)/.exec(mail.text)[1];
  assert.equal((await client(shop.base).get(link)).status, 200);
  assert.ok((await shop.db.query('SELECT email_verified_at FROM webshop.customers WHERE id = $1', [cust.id])).rows[0].email_verified_at);
  assert.equal((await client(shop.base).get(link)).status, 410, 'ссылка одноразовая');
  // новая почта сбрасывает подтверждение, ссылка на старую почту не подтвердит новую
  await shop.db.query("UPDATE webshop.auth_codes SET created_at = created_at - INTERVAL '2 minutes' WHERE target LIKE $1", [`${cust.id}:%`]);
  const mails2 = mailbox.length;
  await c.post('/account/profile', { name: 'Новое имя', email: 'second407@example.ru' }, ip());
  const second = await waitMail(mails2 + 1);
  assert.equal((await shop.db.query('SELECT email_verified_at FROM webshop.customers WHERE id = $1', [cust.id])).rows[0].email_verified_at, null);
  await shop.services.accounts.setProfile(cust.id, { name: 'Новое имя', email: 'third407@example.ru' });
  const stale = /\/login\/verify-email\/[\w-]+/.exec(second.text)[0];
  assert.equal((await client(shop.base).get(stale)).status, 410, 'почта уже другая');
  assert.equal((await shop.db.query('SELECT email_verified_at FROM webshop.customers WHERE id = $1', [cust.id])).rows[0].email_verified_at, null);
});

test('занятая почта в профиле: понятная ошибка', async () => {
  await accountWithPassword('79160000408', { email: 'busy408@example.ru' });
  const c = client(shop.base);
  await loginAs(shop, c, '79160000409');
  await shop.services.accounts.setPassword((await shop.services.accounts.byPhone('79160000409')).id, 'password-1');
  const r = await c.post('/account/profile', { name: 'Имя', email: 'BUSY408@example.ru' }, ip());
  assert.equal(r.status, 422);
  assert.match(r.text, /уже используется/);
});

test('экран «Задайте пароль и почту»: новый аккаунт попадает на него, можно задать или пропустить', async () => {
  const c = client(shop.base);
  const first = await smsLogin(c, '+7 916 000 04 10');
  assert.equal(first.location, '/account/welcome');
  assert.equal((await c.get('/account/welcome')).status, 200);
  const bad = await c.post('/account/welcome', { email: 'w410@example.ru', password: 'short', password2: 'short' }, ip());
  assert.equal(bad.status, 422);
  const ok = await c.post('/account/welcome', { email: 'w410@example.ru', password: 'password-410', password2: 'password-410' }, ip());
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/account');
  assert.equal((await pwLogin(client(shop.base), 'w410@example.ru', 'password-410')).status, 302);
  const skip = await smsLogin(client(shop.base), '+7 916 000 04 11');
  const noPass = await client(shop.base).get('/account/welcome');
  assert.equal(noPass.status, 302, 'без входа экран недоступен');
  assert.equal(skip.location, '/account/welcome');
  assert.equal((await shop.services.accounts.byPhone('79160000411')).password_hash, null, 'пропустили: пароля нет');
});

test('вкладка «Почта и пароль» и ссылка «Забыли пароль?»', async () => {
  const r = await client(shop.base).get('/login?tab=pw');
  assert.match(r.text, /action="\/login\/password"/);
  assert.match(r.text, /href="\/login\/forgot/);
  assert.match(r.text, /Забыли пароль\?/);
});
