'use strict';
// Аккаунты покупателей: это записи webshop.customers. Идентичность - подтверждённый телефон (Telegram или SMS);
// почта и пароль добавляются после первого входа и позволяют входить без кодов.
const { hashPassword, verifyPassword, validateNewPassword } = require('./security');
const { normalizePhone, isEmail, str } = require('./util');

class AccountError extends Error {
  // code: 'weak-password' | 'email-taken' | 'tg-taken' | 'bad-email'
  constructor(code, message) { super(message || code); this.code = code; }
}

const isUnique = (e, index) => e && e.code === '23505' && String(e.constraint || '') === index;

function createAccounts({ db }) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;

  const byId = (id) => one('SELECT * FROM webshop.customers WHERE id = $1', [id]);
  const byPhone = (phone) => one('SELECT * FROM webshop.customers WHERE phone = $1', [normalizePhone(phone)]);

  // Логин: телефон в любом написании или почта аккаунта с паролем
  async function byLogin(login) {
    const s = String(login || '').trim();
    const phone = normalizePhone(s);
    if (phone) return byPhone(phone);
    if (!isEmail(s)) return null;
    return one('SELECT * FROM webshop.customers WHERE lower(email) = lower($1) AND password_hash IS NOT NULL', [s]);
  }

  // Телефон подтверждён кодом: находим клиента (в том числе гостя из прежних заказов) или создаём
  async function ensureByVerifiedPhone(phone, { name = '' } = {}) {
    const { rows } = await db.query(
      `INSERT INTO webshop.customers (phone, name, phone_verified_at) VALUES ($1, $2, NOW())
       ON CONFLICT (phone) DO UPDATE SET phone_verified_at = COALESCE(webshop.customers.phone_verified_at, NOW()),
                                         name = CASE WHEN webshop.customers.name = '' THEN EXCLUDED.name ELSE webshop.customers.name END
       RETURNING *, (xmax = 0) AS created`, [normalizePhone(phone), str(name, 80)]);
    const { created, ...customer } = rows[0];
    return { customer, created };
  }

  async function setPassword(id, password) {
    const bad = validateNewPassword(password);
    if (bad) throw new AccountError('weak-password', bad);
    try {
      await db.query('UPDATE webshop.customers SET password_hash = $2 WHERE id = $1', [id, hashPassword(password)]);
    } catch (e) {
      if (isUnique(e, 'customers_email_login_uq')) throw new AccountError('email-taken', 'Эта почта уже используется для входа');
      throw e;
    }
  }

  const checkPassword = (customer, password) => Boolean(customer && customer.password_hash && verifyPassword(password, customer.password_hash));

  // Имя и почта из профиля. Новая почта не считается подтверждённой.
  async function setProfile(id, { name = '', email = '' }) {
    const n = str(name, 80);
    const e = str(email, 120);
    if (e && !isEmail(e)) throw new AccountError('bad-email', 'Проверьте адрес электронной почты');
    try {
      return await one(
        `UPDATE webshop.customers SET name = CASE WHEN $2 <> '' THEN $2 ELSE name END, email = $3,
                email_verified_at = CASE WHEN lower(email) = lower($3) THEN email_verified_at ELSE NULL END
          WHERE id = $1 RETURNING *`, [id, n, e]);
    } catch (err) {
      if (isUnique(err, 'customers_email_login_uq')) throw new AccountError('email-taken', 'Эта почта уже используется для входа');
      throw err;
    }
  }

  const markEmailVerified = (id) => db.query("UPDATE webshop.customers SET email_verified_at = NOW() WHERE id = $1 AND email <> ''", [id]);

  async function bindTelegram(id, telegramId) {
    try {
      await db.query('UPDATE webshop.customers SET telegram_id = $2 WHERE id = $1', [id, telegramId]);
    } catch (e) {
      if (isUnique(e, 'customers_tg_uq')) throw new AccountError('tg-taken', 'Этот Telegram уже привязан к другому аккаунту');
      throw e;
    }
  }

  const touchLogin = (id) => db.query('UPDATE webshop.customers SET last_login_at = NOW() WHERE id = $1', [id]);

  return { byId, byPhone, byLogin, ensureByVerifiedPhone, setPassword, checkPassword, setProfile, markEmailVerified, bindTelegram, touchLogin };
}

module.exports = { createAccounts, AccountError };
