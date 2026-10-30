#!/usr/bin/env node
'use strict';
// Создаёт или обновляет сотрудника админки.
//   npm run create-admin -- <логин> [owner|manager|editor]      (пароль спросит; можно ADMIN_PASSWORD=...)
const readline = require('readline');
const { load } = require('../src/config');
const { createDb } = require('../src/db');
const { hashPassword, validateNewPassword } = require('../src/security');
const { ROLES } = require('../src/admin/auth');

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const username = String(process.argv[2] || '').toLowerCase();
  const role = process.argv[3] || 'owner';
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || !ROLES[role]) {
    console.error('Использование: npm run create-admin -- <логин: латиница, 3-40 знаков> [owner|manager|editor]');
    process.exit(2);
  }
  const password = process.env.ADMIN_PASSWORD || await ask('Пароль (от 8 знаков): ');
  const err = validateNewPassword(password);
  if (err) { console.error(err); process.exit(2); }
  const db = createDb(load().db);
  await db.migrate();
  await db.query(
    `INSERT INTO webshop.admin_users (username, display_name, password_hash, role) VALUES ($1, $1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = TRUE`,
    [username, hashPassword(password), role]);
  console.log(`Готово: ${username} (${ROLES[role].title})`);
  await db.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
