#!/usr/bin/env node
'use strict';
// Создаёт/обновляет таблицы магазина в схеме webshop (сайт делает это и сам при запуске).
const { load } = require('../src/config');
const { createDb } = require('../src/db');
(async () => {
  const db = createDb(load().db);
  await db.checkAppSchema();
  console.log('Ревизия схемы магазина:', await db.migrate());
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
