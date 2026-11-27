'use strict';
// Миграции базы. База запоминает, сколько команд списка SCHEMA уже выполнено (webshop.meta.schema_rev), поэтому на живой базе
// выполняются только команды, добавленные в КОНЕЦ списка. Эти тесты ловят то, чего не видно на пустой базе (там выполняется всё подряд).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop } = require('./helpers');
const { SCHEMA } = require('../src/schema');

test.describe('миграции базы на уже работающем сервере', () => {
  let shop;
  const cols = async () => (await shop.db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'webshop' AND table_name = 'ext_products'")).rows.map((r) => r.column_name);
  test.before(async () => { shop = await startShop('migration'); });
  test.after(async () => { await shop.stop(); });

  test('каждая команда схемы безопасна при повторном выполнении', async () => {
    for (const q of SCHEMA) await shop.db.query(q);
    for (const q of SCHEMA) await shop.db.query(q);
  });

  test('сервер с версией базы после ошибочного выпуска (колонки скрытых снимков не созданы) чинится при запуске', async () => {
    // в ошибочном выпуске три команды вставили в середину списка: база записала «выполнено на 3 больше», а колонки не создались
    await shop.db.query('ALTER TABLE webshop.ext_products DROP COLUMN hidden_images, DROP COLUMN images_scan, DROP COLUMN images_scan_at');
    await shop.db.query("UPDATE webshop.meta SET value = $1 WHERE key = 'schema_rev'", [String(SCHEMA.length - 3)]);
    assert.ok(!(await cols()).includes('hidden_images'));
    await assert.rejects(shop.services.partner.get('baza').rows(), /hidden_images/, 'без колонки каталог электроники не загружается');
    await shop.db.migrate();
    const have = await cols();
    for (const c of ['hidden_images', 'images_scan', 'images_scan_at']) assert.ok(have.includes(c), c);
    assert.deepEqual(await shop.services.partner.get('baza').rows(), []);
    assert.equal((await shop.db.query("SELECT value FROM webshop.meta WHERE key = 'schema_rev'")).rows[0].value, String(SCHEMA.length));
  });

  test('обычное обновление: база прежней версии получает новые колонки, повторный запуск ничего не меняет', async () => {
    await shop.db.query('ALTER TABLE webshop.ext_products DROP COLUMN hidden_images, DROP COLUMN images_scan, DROP COLUMN images_scan_at');
    await shop.db.query("UPDATE webshop.meta SET value = $1 WHERE key = 'schema_rev'", [String(SCHEMA.length - 6)]);   // версия до выпуска с проверкой снимков
    await shop.db.migrate();
    assert.ok((await cols()).includes('images_scan'));
    await shop.db.migrate();
    assert.ok((await cols()).includes('hidden_images'));
  });
});
