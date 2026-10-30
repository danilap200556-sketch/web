'use strict';
const fs = require('fs');
const { Pool } = require('pg');
const { SCHEMA } = require('./schema');

// Сеть до облачной БД может обрывать простаивающие соединения. Чтение
// безопасно повторить один раз; запись не повторяем, чтобы не выполнить дважды.
function isConnectionError(e) {
  return !e.code || /^(08|57P0|53300)/.test(e.code) || /ECONN|EPIPE|ETIMEDOUT|terminated|timeout/i.test(e.message || '');
}

function createDb(cfg) {
  let ssl = false;
  if (cfg.ssl === 'require') ssl = { rejectUnauthorized: false };
  if (cfg.ssl === 'verify') {
    ssl = { rejectUnauthorized: true };
    if (cfg.sslCaFile) ssl.ca = fs.readFileSync(cfg.sslCaFile, 'utf8');
  }
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl,
    max: cfg.poolSize,
    connectionTimeoutMillis: 20000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
    statement_timeout: 30000,
    application_name: 'shop-web',
  });
  pool.on('error', (e) => console.error('[db] ошибка простаивающего соединения:', e.message));

  async function query(text, params) {
    try {
      return await pool.query(text, params);
    } catch (e) {
      if (/^\s*(select|with)/i.test(text) && isConnectionError(e)) return pool.query(text, params);
      throw e;
    }
  }

  async function tx(fn) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw e;
    } finally {
      client.release(broken);
    }
  }

  // Таблицы склада создаёт и обновляет настольное приложение - сайт их только читает.
  // Проверяем, что приложение уже подготовило эту базу.
  const required = [
    ['products', 'sku'], ['products', 'name'], ['products', 'price'], ['products', 'market_vendor'],
    ['stock', 'quantity'], ['product_photos', 'data'], ['product_photos', 'thumb'],
  ];
  async function checkAppSchema() {
    const { rows } = await pool.query(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ANY(current_schemas(false))');
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = required.map(([t, c]) => `${t}.${c}`).filter((k) => !have.has(k));
    if (missing.length) {
      throw new Error('В базе нет: ' + missing.join(', ') +
        '. Запустите последнюю версию приложения «Склад» один раз с этой базой - оно создаст и обновит таблицы.');
    }
  }

  // Собственные таблицы магазина лежат в отдельной схеме `webshop` и не пересекаются с таблицами склада.
  async function migrate() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Блокировка живёт до конца транзакции: сеансовая (pg_advisory_lock) через пулер соединений Яндекса (порт 6432, режим
      // transaction) могла бы остаться на чужом соединении и повесить следующий запуск. Заодно миграция атомарна.
      await client.query('SELECT pg_advisory_xact_lock(727301)');
      await client.query('CREATE SCHEMA IF NOT EXISTS webshop');
      await client.query('CREATE TABLE IF NOT EXISTS webshop.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const cur = await client.query("SELECT value FROM webshop.meta WHERE key = 'schema_rev'");
      const have = cur.rows[0] ? parseInt(cur.rows[0].value, 10) : 0;
      if (have < SCHEMA.length) {
        for (let i = have; i < SCHEMA.length; i++) await client.query(SCHEMA[i]);
        await client.query(
          `INSERT INTO webshop.meta (key, value) VALUES ('schema_rev', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(SCHEMA.length)]);
      }
      await client.query('COMMIT');
      return Math.max(have, SCHEMA.length);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* соединение закроется само */ }
      throw e;
    } finally {
      client.release();
    }
  }

  return { pool, query, tx, checkAppSchema, migrate, end: () => pool.end() };
}

module.exports = { createDb };
