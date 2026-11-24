'use strict';
// Одноразовые коды (SMS, Telegram) и токены для ссылок из писем. В базе только HMAC, сам код не хранится.
// Лимиты считаются запросами к таблице, поэтому переживают перезапуск сайта и работают при нескольких процессах.
const crypto = require('crypto');
const { safeEqual } = require('./security');

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const PER_TARGET = { minute: 1, hour: 5, day: 10 };
const PER_IP_HOUR = 20;

class CodeError extends Error {
  // reason: 'rate' - слишком часто, 'cap' - исчерпан суточный потолок SMS
  constructor(reason) { super(reason); this.reason = reason; }
}

function createCodes({ db, cfg }) {
  const mac = (s) => crypto.createHmac('sha256', cfg.secret).update(s).digest('hex');
  const codeHash = (purpose, target, code) => mac(`code:${purpose}:${target}:${code}`);
  const tokenHash = (purpose, token) => mac(`token:${purpose}:${token}`);

  // Проверка лимитов и запись новой строки одной транзакцией: два одновременных запроса на один адрес не проскочат оба
  async function insert({ purpose, channel, target, ip = '', hash, minutes }) {
    return db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auth:${target}`]);
      const t = (await c.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 minute')::int AS m,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS h, COUNT(*)::int AS d
           FROM webshop.auth_codes WHERE target = $1 AND created_at > NOW() - INTERVAL '1 day'`, [target])).rows[0];
      if (t.m >= PER_TARGET.minute || t.h >= PER_TARGET.hour || t.d >= PER_TARGET.day) throw new CodeError('rate');
      if (ip) {
        const n = (await c.query("SELECT COUNT(*)::int AS n FROM webshop.auth_codes WHERE ip = $1 AND created_at > NOW() - INTERVAL '1 hour'", [ip])).rows[0].n;
        if (n >= PER_IP_HOUR) throw new CodeError('rate');
      }
      if (channel === 'sms') {
        const n = (await c.query("SELECT COUNT(*)::int AS n FROM webshop.auth_codes WHERE channel = 'sms' AND created_at > NOW() - INTERVAL '1 day'")).rows[0].n;
        if (n >= cfg.sms.dailyCap) throw new CodeError('cap');
      }
      await c.query(
        `INSERT INTO webshop.auth_codes (purpose, channel, target, code_hash, expires_at, ip) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5), $6)`,
        [purpose, channel, target, hash, minutes, String(ip).slice(0, 64)]);
    });
  }

  // Шестизначный код для адресата (телефон, ссылка-токен Telegram). Выбрасывает CodeError при превышении лимитов.
  async function issue({ purpose, channel, target, ip = '' }) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await insert({ purpose, channel, target, ip, hash: codeHash(purpose, target, code), minutes: CODE_TTL_MIN });
    return { code };
  }

  // Проверяет последний выданный код: действует 10 минут, пять попыток, потом код сгорает. Верный код работает один раз.
  async function verify({ purpose, target, code }) {
    if (!/^\d{6}$/.test(String(code || ''))) return false;
    return db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, code_hash FROM webshop.auth_codes
          WHERE purpose = $1 AND target = $2 AND used_at IS NULL AND expires_at > NOW() AND attempts < $3
          ORDER BY id DESC LIMIT 1 FOR UPDATE`, [purpose, target, MAX_ATTEMPTS]);
      const row = rows[0];
      if (!row) return false;
      if (safeEqual(row.code_hash, codeHash(purpose, target, code))) {
        await c.query('UPDATE webshop.auth_codes SET used_at = NOW() WHERE id = $1', [row.id]);
        return true;
      }
      await c.query('UPDATE webshop.auth_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return false;
    });
  }

  // Длинный токен для ссылки из письма. target - то, к чему он привязан (например, номер клиента).
  async function issueToken({ purpose, target, hours = 1, ip = '' }) {
    const token = crypto.randomBytes(32).toString('base64url');
    await insert({ purpose, channel: 'mail', target: String(target), ip, hash: tokenHash(purpose, token), minutes: Math.round(hours * 60) });
    return { token };
  }

  // Гасит токен и возвращает его target; просроченный, использованный или чужой даёт null
  async function consumeToken({ purpose, token }) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const { rows } = await db.query(
      `UPDATE webshop.auth_codes SET used_at = NOW()
        WHERE purpose = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > NOW() RETURNING target`, [purpose, tokenHash(purpose, token)]);
    return rows[0] ? rows[0].target : null;
  }

  return { issue, verify, issueToken, consumeToken };
}

module.exports = { createCodes, CodeError };
