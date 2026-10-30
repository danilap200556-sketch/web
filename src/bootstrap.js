'use strict';
const { hashPassword } = require('./security');

// Первый запуск: способы доставки по умолчанию и владелец админки из ADMIN_USER / ADMIN_PASSWORD
async function bootstrap({ db, cfg, delivery, carts, writeoff, notifier }) {
  await delivery.ensureDefaults();
  await writeoff.sync();   // очередь списания: заказы «Собран» встают в неё, отменённые снимаются
  writeoff.start();
  notifier.start();        // отправка уведомлений о заказах (Telegram), если он настроен
  if (cfg.notify.telegramToken && !cfg.notify.telegramChatIds.length) console.warn('[!] Задан TELEGRAM_BOT_TOKEN, но нет TELEGRAM_CHAT_ID: уведомления не отправляются.');
  carts.prune().catch(() => {});
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM webshop.admin_users');
  if (!rows[0].n && cfg.bootstrapAdmin) {
    const { username, password } = cfg.bootstrapAdmin;
    await db.query(
      "INSERT INTO webshop.admin_users (username, display_name, password_hash, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING",
      [username.toLowerCase(), 'Владелец', hashPassword(password)]);
    console.log(`Создан владелец админки: ${username}. Смените пароль после первого входа.`);
  } else if (!rows[0].n) {
    console.warn('Нет ни одного администратора. Создайте: npm run create-admin -- <логин>   (или задайте ADMIN_USER и ADMIN_PASSWORD)');
  }
}

module.exports = { bootstrap };
