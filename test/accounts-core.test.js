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
