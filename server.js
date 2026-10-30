'use strict';
const { load } = require('./src/config');
const { createDb } = require('./src/db');
const { createApp } = require('./src/app');
const { bootstrap } = require('./src/bootstrap');

async function main() {
  const cfg = load();
  const db = createDb(cfg.db);
  await db.checkAppSchema();
  await db.migrate();
  const app = createApp(cfg, db);
  await bootstrap(app.locals.services);

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`Магазин запущен: http://${cfg.host}:${cfg.port} (БД ${cfg.db.host}:${cfg.db.port}/${cfg.db.database}, TLS: ${cfg.db.ssl})`);
    if (!cfg.secureCookies) console.warn('[!] COOKIE_SECURE выключен: без HTTPS пароли передаются открытым текстом.');
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`${sig}: останавливаюсь`);
      server.close(async () => { await app.locals.shutdown(); db.end().finally(() => process.exit(0)); });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((e) => { console.error('Не удалось запустить:', e.message); process.exit(1); });
