'use strict';
// Сессии покупателей. В cookie лежит случайный токен, в базе только его sha256: утечка базы не даёт войти.
// Сессия живёт CUSTOMER_SESSION_DAYS дней с продлением при использовании. «Свежая» (вход по коду или по ссылке из письма)
// 15 минут: пока она свежая, пароль можно сменить без старого.
const crypto = require('crypto');

const FRESH_MINUTES = 15;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createSessions({ db, cfg }) {
  const cookieName = cfg.secureCookies ? '__Host-cs' : 'cs';
  const days = cfg.customer.sessionDays;

  async function create(customerId, { ip = '', ua = '', fresh = false } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO webshop.customer_sessions (customer_id, token_hash, expires_at, fresh_until, ip, ua)
       VALUES ($1, $2, NOW() + make_interval(days => $3), CASE WHEN $4::boolean THEN NOW() + make_interval(mins => $5) END, $6, $7)`,
      [customerId, hash(token), days, fresh, FRESH_MINUTES, String(ip).slice(0, 64), String(ua).slice(0, 200)]);
    db.query("DELETE FROM webshop.customer_sessions WHERE expires_at < NOW() - INTERVAL '7 days'").catch(() => {});
    return token;
  }

  // Клиент и признак «свежести» по токену из cookie; просроченная или чужая сессия - null.
  async function resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const { rows } = await db.query(
      `SELECT s.id AS session_id, (s.fresh_until > NOW()) AS fresh, c.*
         FROM webshop.customer_sessions s JOIN webshop.customers c ON c.id = s.customer_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [hash(token)]);
    if (!rows[0]) return null;
    const { session_id: sessionId, fresh, ...customer } = rows[0];
    // Продлеваем не чаще раза в 10 минут, чтобы не писать в базу при каждом запросе
    db.query(
      `UPDATE webshop.customer_sessions SET last_seen_at = NOW(), expires_at = NOW() + make_interval(days => $2)
        WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '10 minutes'`, [sessionId, days]).catch(() => {});
    return { customer, sessionId, fresh: Boolean(fresh) };
  }

  async function destroy(token) {
    if (token) await db.query('DELETE FROM webshop.customer_sessions WHERE token_hash = $1', [hash(token)]);
  }

  // Выход на всех устройствах (кроме текущего, если передан его токен)
  async function destroyAll(customerId, exceptToken = null) {
    await db.query('DELETE FROM webshop.customer_sessions WHERE customer_id = $1 AND ($2::text IS NULL OR token_hash <> $2)',
      [customerId, exceptToken ? hash(exceptToken) : null]);
  }

  return { cookieName, create, resolve, destroy, destroyAll };
}

module.exports = { createSessions, FRESH_MINUTES };
