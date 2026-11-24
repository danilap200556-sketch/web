'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop } = require('./helpers');
const { load } = require('../src/config');

let shop;
test.before(async () => { shop = await startShop('acc_schema'); });
test.after(async () => { await shop.stop(); });

const col = async (table, column) => (await shop.db.query(
  "SELECT 1 FROM information_schema.columns WHERE table_schema = 'webshop' AND table_name = $1 AND column_name = $2", [table, column])).rowCount === 1;
const addCustomer = (phone, extra = {}) => shop.db.query(
  `INSERT INTO webshop.customers (phone, name, email, password_hash, telegram_id, personal_discount) VALUES ($1, 'T', $2, $3, $4, $5) RETURNING id`,
  [phone, extra.email || '', extra.password_hash || null, extra.telegram_id || null, extra.personal_discount || 0]);

test('схема аккаунтов: колонки и таблицы есть, повторная миграция не падает', async () => {
  await shop.db.migrate();
  for (const [t, c] of [['customers', 'password_hash'], ['customers', 'phone_verified_at'], ['customers', 'email_verified_at'], ['customers', 'telegram_id'],
    ['customers', 'tg_notify'], ['customers', 'personal_discount'], ['customers', 'last_login_at'], ['outbox', 'payload'],
    ['orders', 'discount'], ['orders', 'discount_pct'], ['orders', 'discount_note'],
    ['customer_sessions', 'token_hash'], ['customer_sessions', 'fresh_until'], ['auth_codes', 'code_hash'], ['auth_codes', 'attempts'], ['tg_login', 'token']]) {
    assert.ok(await col(t, c), `${t}.${c}`);
  }
});

test('личная скидка вне 0..100 отклоняется', async () => {
  await assert.rejects(addCustomer('79160000101', { personal_discount: 101 }), /check/i);
});

test('telegram_id уникален среди клиентов', async () => {
  await addCustomer('79160000102', { telegram_id: 4242 });
  await assert.rejects(addCustomer('79160000103', { telegram_id: 4242 }), /unique|duplicate/i);
});

test('почта для входа уникальна только среди аккаунтов с паролем', async () => {
  await addCustomer('79160000104', { email: 'Same@x.ru' });            // без пароля: дубли допустимы
  await addCustomer('79160000105', { email: 'same@x.ru' });
  await addCustomer('79160000106', { email: 'Login@x.ru', password_hash: 'scrypt$a$b' });
  await assert.rejects(addCustomer('79160000107', { email: 'login@X.ru', password_hash: 'scrypt$a$b' }), /unique|duplicate/i);
});

test('боевой режим не принимает SMS_PROVIDER=console', () => {
  const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) };
  assert.throws(() => load({ ...base, SMS_PROVIDER: 'console' }), /SMS_PROVIDER/);
  assert.throws(() => load({ ...base, SMS_PROVIDER: 'nope' }), /SMS_PROVIDER/);
  const cfg = load({ ...base, SMS_PROVIDER: 'smsru', SMS_API_KEY: 'k', SMTP_HOST: 'smtp.x.ru', SMTP_PORT: '465', SMTP_SECURE: 'true' });
  assert.equal(cfg.sms.provider, 'smsru');
  assert.equal(cfg.sms.dailyCap, 300);
  assert.equal(cfg.smtp.port, 465);
  assert.equal(cfg.smtp.secure, true);
  assert.equal(cfg.customer.sessionDays, 30);
});

// ---------- Сессии, коды и аккаунты ----------
const { createSessions } = require('../src/customer-sessions');
const { createCodes } = require('../src/auth-codes');
const { createAccounts } = require('../src/accounts');

const shiftCodes = (target, interval) => shop.db.query(
  `UPDATE webshop.auth_codes SET created_at = created_at - $2::interval, expires_at = expires_at - $2::interval WHERE target = $1`, [target, interval]);

test('сессии: вход, продление, «свежесть», срок, выход на всех устройствах', async () => {
  const accounts = createAccounts({ db: shop.db });
  const sessions = createSessions({ db: shop.db, cfg: shop.cfg });
  const { customer } = await accounts.ensureByVerifiedPhone('79160000301', { name: 'Аня' });
  const t1 = await sessions.create(customer.id, { ip: '1.1.1.1', ua: 'x' });
  const t2 = await sessions.create(customer.id, { ip: '1.1.1.2', ua: 'y', fresh: true });
  assert.equal(sessions.cookieName, 'cs');                 // в тестах cookie без __Host-
  const r1 = await sessions.resolve(t1);
  assert.equal(r1.customer.id, customer.id);
  assert.equal(r1.fresh, false);
  assert.equal((await sessions.resolve(t2)).fresh, true);
  await shop.db.query("UPDATE webshop.customer_sessions SET fresh_until = NOW() - INTERVAL '1 s' WHERE fresh_until IS NOT NULL");
  assert.equal((await sessions.resolve(t2)).fresh, false);
  assert.equal(await sessions.resolve('чужой-токен'), null);
  assert.equal(await sessions.resolve(''), null);
  const raw = await shop.db.query('SELECT token_hash FROM webshop.customer_sessions');
  assert.ok(raw.rows.every((r) => r.token_hash !== t1 && r.token_hash !== t2 && r.token_hash.length === 64), 'в базе только хэш');
  await sessions.destroyAll(customer.id, t1);
  assert.equal(await sessions.resolve(t2), null);
  assert.ok(await sessions.resolve(t1));
  await shop.db.query("UPDATE webshop.customer_sessions SET expires_at = NOW() - INTERVAL '1 s'");
  assert.equal(await sessions.resolve(t1), null, 'просроченная сессия не работает');
  const t3 = await sessions.create(customer.id, { ip: '', ua: '' });
  await sessions.destroy(t3);
  assert.equal(await sessions.resolve(t3), null);
});

test('коды: верный проходит один раз, неверный нет, просроченный нет', async () => {
  const codes = createCodes({ db: shop.db, cfg: shop.cfg });
  const target = '79160000311';
  const { code } = await codes.issue({ purpose: 'login-sms', channel: 'sms', target, ip: '2.2.2.2' });
  assert.match(code, /^\d{6}$/);
  const raw = await shop.db.query('SELECT code_hash FROM webshop.auth_codes WHERE target = $1', [target]);
  assert.ok(!raw.rows[0].code_hash.includes(code), 'код в базе не хранится');
  assert.equal(await codes.verify({ purpose: 'login-sms', target, code: code === '000000' ? '000001' : '000000' }), false);
  assert.equal(await codes.verify({ purpose: 'login-sms', target: '79160000399', code }), false, 'код другого адресата');
  assert.equal(await codes.verify({ purpose: 'reset', target, code }), false, 'код другого назначения');
  assert.equal(await codes.verify({ purpose: 'login-sms', target, code }), true);
  assert.equal(await codes.verify({ purpose: 'login-sms', target, code }), false, 'повторно нельзя');
  await shiftCodes(target, '2 minutes');
  const second = await codes.issue({ purpose: 'login-sms', channel: 'sms', target, ip: '2.2.2.2' });
  await shop.db.query("UPDATE webshop.auth_codes SET expires_at = NOW() - INTERVAL '1 s' WHERE target = $1", [target]);
  assert.equal(await codes.verify({ purpose: 'login-sms', target, code: second.code }), false, 'просрочен');
});

test('коды: пятая неверная попытка сжигает код, верный после этого тоже не проходит', async () => {
  const codes = createCodes({ db: shop.db, cfg: shop.cfg });
  const target = '79160000312';
  const { code } = await codes.issue({ purpose: 'login-sms', channel: 'sms', target, ip: '' });
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal(await codes.verify({ purpose: 'login-sms', target, code: wrong }), false);
  assert.equal(await codes.verify({ purpose: 'login-sms', target, code }), false);
});

test('коды: лимиты на адресат (минута, час), на IP и суточный потолок SMS', async () => {
  const codes = createCodes({ db: shop.db, cfg: shop.cfg });
  const issue = (target, over = {}) => codes.issue({ purpose: 'login-sms', channel: 'sms', target, ip: '', ...over });
  const t = '79160000313';
  await issue(t);
  await assert.rejects(issue(t), { reason: 'rate' });          // не чаще раза в минуту
  for (let i = 0; i < 4; i++) { await shiftCodes(t, '2 minutes'); await issue(t); }   // всего пять за час
  await shiftCodes(t, '2 minutes');
  await assert.rejects(issue(t), { reason: 'rate' });          // шестая за час
  // на IP: 20 в час
  for (let i = 0; i < 20; i++) await issue(`7916000${String(4000 + i)}`, { ip: '9.9.9.9' });
  await assert.rejects(issue('79160005000', { ip: '9.9.9.9' }), { reason: 'rate' });
  // суточный потолок SMS: считаются только SMS за последние сутки
  await shop.db.query("UPDATE webshop.auth_codes SET created_at = NOW() - INTERVAL '2 days', expires_at = NOW() - INTERVAL '2 days'");
  const capped = createCodes({ db: shop.db, cfg: { ...shop.cfg, sms: { ...shop.cfg.sms, dailyCap: 2 } } });
  await capped.issue({ purpose: 'login-sms', channel: 'sms', target: '79160006001', ip: '' });
  await capped.issue({ purpose: 'login-sms', channel: 'sms', target: '79160006002', ip: '' });
  await assert.rejects(capped.issue({ purpose: 'login-sms', channel: 'sms', target: '79160006003', ip: '' }), { reason: 'cap' });
  await capped.issue({ purpose: 'tg', channel: 'tg', target: 'токен-ссылки', ip: '' });   // потолок касается только SMS
});

test('токены для писем: одноразовые, привязаны к назначению, со сроком', async () => {
  const codes = createCodes({ db: shop.db, cfg: shop.cfg });
  const { token } = await codes.issueToken({ purpose: 'reset-mail', target: '77' });
  assert.ok(token.length >= 32);
  assert.equal(await codes.consumeToken({ purpose: 'verify-email', token }), null);
  assert.equal(await codes.consumeToken({ purpose: 'reset-mail', token }), '77');
  assert.equal(await codes.consumeToken({ purpose: 'reset-mail', token }), null);
  const old = await codes.issueToken({ purpose: 'reset-mail', target: '78' });
  await shop.db.query("UPDATE webshop.auth_codes SET expires_at = NOW() - INTERVAL '1 s' WHERE target = '78'");
  assert.equal(await codes.consumeToken({ purpose: 'reset-mail', token: old.token }), null);
});

test('аккаунты: вход по подтверждённому телефону создаёт или находит клиента', async () => {
  const accounts = createAccounts({ db: shop.db });
  const a = await accounts.ensureByVerifiedPhone('79160000321', { name: 'Аня' });
  assert.equal(a.created, true);
  assert.ok(a.customer.phone_verified_at);
  const again = await accounts.ensureByVerifiedPhone('79160000321', { name: 'Другое имя' });
  assert.equal(again.created, false);
  assert.equal(again.customer.name, 'Аня', 'имя не затирается');
  // гость из заказа: запись уже есть, телефон ещё не подтверждён
  const g = await shop.db.query("INSERT INTO webshop.customers (phone, name) VALUES ('79160000322', 'Гость') RETURNING id");
  const verified = await accounts.ensureByVerifiedPhone('79160000322', {});
  assert.equal(verified.created, false);
  assert.equal(verified.customer.id, g.rows[0].id);
  assert.ok(verified.customer.phone_verified_at);
  assert.equal((await accounts.byLogin('8 (916) 000-03-21')).id, a.customer.id);
  assert.equal(await accounts.byLogin('не-номер-и-не-почта'), null);
});

test('аккаунты: пароль, почта как логин, занятая почта, привязка Telegram', async () => {
  const accounts = createAccounts({ db: shop.db });
  const a1 = (await accounts.ensureByVerifiedPhone('79160000331', { name: 'Один' })).customer;
  const a2 = (await accounts.ensureByVerifiedPhone('79160000332', { name: 'Два' })).customer;
  await assert.rejects(accounts.setPassword(a1.id, '123'), { code: 'weak-password' });
  await assert.rejects(accounts.setProfile(a1.id, { name: 'Один', email: 'не почта' }), { code: 'bad-email' });
  await accounts.setProfile(a1.id, { name: 'Один', email: 'A@x.ru' });
  await accounts.setPassword(a1.id, 'password-1');
  const withPass = await accounts.byId(a1.id);
  assert.ok(withPass.password_hash.startsWith('scrypt$'));
  assert.equal(accounts.checkPassword(withPass, 'password-1'), true);
  assert.equal(accounts.checkPassword(withPass, 'password-2'), false);
  assert.equal((await accounts.byLogin(' a@X.RU ')).id, a1.id);
  await accounts.setProfile(a2.id, { name: 'Два', email: 'a@x.ru' });   // без пароля почта ещё никого не блокирует
  await assert.rejects(accounts.setPassword(a2.id, 'password-2'), { code: 'email-taken' });
  await accounts.markEmailVerified(a1.id);
  assert.ok((await accounts.byId(a1.id)).email_verified_at);
  await accounts.setProfile(a1.id, { name: 'Один Новый', email: 'a@x.ru' });   // та же почта: подтверждение не сбрасывается
  assert.ok((await accounts.byId(a1.id)).email_verified_at);
  await accounts.setProfile(a1.id, { name: 'Один Новый', email: 'b@x.ru' });
  assert.equal((await accounts.byId(a1.id)).email_verified_at, null, 'новая почта не подтверждена');
  await accounts.bindTelegram(a1.id, 777001);
  await accounts.bindTelegram(a1.id, 777001);                            // повторная привязка того же не ошибка
  await assert.rejects(accounts.bindTelegram(a2.id, 777001), { code: 'tg-taken' });
  await accounts.touchLogin(a1.id);
  assert.ok((await accounts.byId(a1.id)).last_login_at);
});
