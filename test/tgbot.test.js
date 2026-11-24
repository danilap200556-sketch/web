'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, fakeTelegram } = require('./helpers');
const { createAccounts } = require('../src/accounts');
const { createCodes } = require('../src/auth-codes');
const { createBot } = require('../src/tgbot');

const TOKEN = '123456:TEST-token-abcdefghijklmnopqrstuvwxyz0123';
let tg, shop, accounts, codes, bot;

test.before(async () => {
  tg = await fakeTelegram();
  shop = await startShop('tgbot', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '1', TELEGRAM_API_URL: tg.url });
  accounts = createAccounts({ db: shop.db });
  codes = createCodes({ db: shop.db, cfg: shop.cfg });
  bot = createBot({ db: shop.db, cfg: shop.cfg, accounts, codes });
});
test.after(async () => { await shop.stop(); await tg.close(); });

let uid = 1000;
const msg = (from, extra, chatType = 'private') => ({ update_id: ++uid, message: { message_id: uid, from: { id: from, is_bot: false, first_name: 'Т' }, chat: { id: from, type: chatType }, date: 0, ...extra } });
const startUpdate = (token, { from, kind = 'L', chatType } = {}) => msg(from, { text: `/start ${kind}${token}` }, chatType);
const contactUpdate = ({ from, contactUser, phone }) => msg(from, { contact: { phone_number: phone, first_name: 'Т', user_id: contactUser } });
const sent = () => tg.calls.filter((c) => c.url.endsWith('/sendMessage'));
const lastMsg = () => sent().at(-1).body;
const codeFrom = (m) => /Код для входа: (\d{6})/.exec(m.text)[1];
const row = async (token) => (await shop.db.query('SELECT * FROM webshop.tg_login WHERE token = $1', [token])).rows[0];
const verified = async (phone, tgId) => {
  const { customer } = await accounts.ensureByVerifiedPhone(phone, { name: 'Т' });
  await accounts.bindTelegram(customer.id, tgId);
  return customer;
};

test('ссылка входа ведёт на бота, имя бота узнаётся у Telegram один раз', async () => {
  const before = tg.calls.filter((c) => c.url.endsWith('/getMe')).length;
  const { token, url } = await bot.createLink({ purpose: 'login' });
  assert.equal(url, `https://t.me/solehouse_test_bot?start=L${token}`);
  assert.ok(token.length >= 20);
  const link = await bot.createLink({ purpose: 'link', customerId: 5 });
  assert.match(link.url, /\?start=K/);
  assert.equal(tg.calls.filter((c) => c.url.endsWith('/getMe')).length - before, 1);
});

test('вход: просит контакт, чужой контакт отклоняет, свой принимает и присылает код', async () => {
  const { token } = await bot.createLink({ purpose: 'login' });
  await bot.handleUpdate(startUpdate(token, { from: 555 }));
  assert.equal(lastMsg().chat_id, 555);
  assert.equal(lastMsg().reply_markup.keyboard[0][0].request_contact, true);
  const n = sent().length;
  await bot.handleUpdate(contactUpdate({ from: 555, contactUser: 777, phone: '+79160000001' }));   // контакт другого человека
  assert.match(lastMsg().text, /собственный номер|свой номер/i);
  assert.equal((await row(token)).phone, null);
  assert.equal(sent().length, n + 1);
  await bot.handleUpdate(contactUpdate({ from: 555, contactUser: 555, phone: '+7 916 000-00-01' }));
  const code = codeFrom(lastMsg());
  assert.match(lastMsg().text, /Никому не сообщайте/);
  assert.equal(lastMsg().reply_markup.remove_keyboard, true);
  const r = await row(token);
  assert.equal(r.phone, '79160000001');
  assert.equal(String(r.telegram_id), '555');
  assert.equal(await codes.verify({ purpose: 'tg', target: token, code }), true);
  assert.equal(await codes.verify({ purpose: 'tg', target: token, code }), false);
});

test('сообщения не из личного чата игнорируются', async () => {
  const { token } = await bot.createLink({ purpose: 'login' });
  const n = sent().length;
  await bot.handleUpdate(startUpdate(token, { from: 556, chatType: 'group' }));
  await bot.handleUpdate({ update_id: ++uid, edited_message: { text: 'x' } });
  await bot.handleUpdate({});
  assert.equal(sent().length, n);
  assert.equal((await row(token)).telegram_id, null);
});

test('просроченная и чужая ссылка не принимаются', async () => {
  const { token } = await bot.createLink({ purpose: 'login' });
  await shop.db.query("UPDATE webshop.tg_login SET expires_at = NOW() - INTERVAL '1 s' WHERE token = $1", [token]);
  await bot.handleUpdate(startUpdate(token, { from: 557 }));
  assert.match(lastMsg().text, /устарела|заново/i);
  assert.equal(lastMsg().reply_markup, undefined);
  assert.equal((await row(token)).telegram_id, null);
  // ссылка уже занята другим пользователем Telegram
  const t2 = (await bot.createLink({ purpose: 'login' })).token;
  await bot.handleUpdate(startUpdate(t2, { from: 558 }));
  await bot.handleUpdate(startUpdate(t2, { from: 559 }));
  assert.match(lastMsg().text, /устарела|использована|заново/i);
  assert.equal(String((await row(t2)).telegram_id), '558');
  // выдуманный токен и ссылка другого назначения
  await bot.handleUpdate(startUpdate('выдуманный-токен-1234567890', { from: 560 }));
  assert.match(lastMsg().text, /устарела|заново/i);
  const t3 = (await bot.createLink({ purpose: 'login' })).token;
  await bot.handleUpdate(startUpdate(t3, { from: 561, kind: 'K' }));
  assert.match(lastMsg().text, /устарела|заново/i);
  assert.equal((await row(t3)).telegram_id, null);
});

test('уже привязанный Telegram получает код сразу, без просьбы про контакт', async () => {
  const cust = await verified('79160000011', 600);
  const { token } = await bot.createLink({ purpose: 'login' });
  await bot.handleUpdate(startUpdate(token, { from: 600 }));
  assert.equal(lastMsg().chat_id, 600);
  assert.equal(lastMsg().reply_markup.keyboard, undefined);
  const code = codeFrom(lastMsg());
  assert.equal((await row(token)).phone, cust.phone);
  assert.equal(await codes.verify({ purpose: 'tg', target: token, code }), true);
});

test('привязка из кабинета: номер Telegram обязан совпасть с номером аккаунта', async () => {
  const { customer } = await accounts.ensureByVerifiedPhone('79160000021', { name: 'Т' });
  const { token } = await bot.createLink({ purpose: 'link', customerId: customer.id });
  await bot.handleUpdate(startUpdate(token, { from: 610, kind: 'K' }));
  await bot.handleUpdate(contactUpdate({ from: 610, contactUser: 610, phone: '+79160000022' }));    // другой номер
  assert.match(lastMsg().text, /не совпада/i);
  assert.equal((await row(token)).phone, null);
  await bot.handleUpdate(contactUpdate({ from: 610, contactUser: 610, phone: '79160000021' }));
  assert.equal(await codes.verify({ purpose: 'tg', target: token, code: codeFrom(lastMsg()) }), true);
  assert.equal((await row(token)).phone, '79160000021');
});

test('не российский номер отклоняется', async () => {
  const { token } = await bot.createLink({ purpose: 'login' });
  await bot.handleUpdate(startUpdate(token, { from: 620 }));
  await bot.handleUpdate(contactUpdate({ from: 620, contactUser: 620, phone: '+380501234567' }));
  assert.match(lastMsg().text, /российск/i);
  assert.equal((await row(token)).phone, null);
});

test('контакт без начатого входа не создаёт ничего', async () => {
  const n = sent().length;
  await bot.handleUpdate(contactUpdate({ from: 630, contactUser: 630, phone: '+79160000031' }));
  assert.equal(sent().length, n + 1);
  assert.match(lastMsg().text, /сайт/i);
});

test('команды /stop и /notify переключают уведомления, посторонним объясняют', async () => {
  const cust = await verified('79160000041', 700);
  await bot.handleUpdate(msg(700, { text: '/stop' }));
  assert.equal((await accounts.byId(cust.id)).tg_notify, false);
  await bot.handleUpdate(msg(700, { text: '/notify' }));
  assert.equal((await accounts.byId(cust.id)).tg_notify, true);
  await bot.handleUpdate(msg(701, { text: '/stop' }));        // Telegram не привязан ни к кому
  assert.match(lastMsg().text, /привяз/i);
  await bot.handleUpdate(msg(701, { text: '/start' }));
  assert.match(lastMsg().text, /сайт/i);
});

test('sendToCustomer: успех, блокировка бота (403), сбой сервера', async () => {
  assert.deepEqual(await bot.sendToCustomer(800, 'Привет'), { ok: true, blocked: false });
  assert.equal(lastMsg().chat_id, 800);
  tg.mode.blocked.add('801');
  assert.deepEqual(await bot.sendToCustomer(801, 'Привет'), { ok: false, blocked: true });
  tg.mode.blocked.clear();
  tg.mode.fail = 1;
  assert.deepEqual(await bot.sendToCustomer(802, 'Привет'), { ok: false, blocked: false });
});

test('опрос: обновление обрабатывается, следующий запрос идёт с offset, конфликт 409 не падает', async () => {
  const { token } = await bot.createLink({ purpose: 'login' });
  const u = startUpdate(token, { from: 900 });
  tg.updates.push(u);
  assert.equal(await bot.pollOnce(0), 1);
  assert.equal(String((await row(token)).telegram_id), '900');
  await bot.pollOnce(0);
  const polls = tg.calls.filter((c) => c.url.endsWith('/getUpdates'));
  assert.equal(polls.at(-1).body.offset, u.update_id + 1);
  assert.equal(polls.at(-1).body.timeout, 0);
  tg.mode.conflict = true;
  assert.equal(await bot.pollOnce(0), 'conflict');
  tg.mode.conflict = false;
});

test('без токена бот выключен', async () => {
  const off = createBot({ db: shop.db, cfg: { ...shop.cfg, notify: { ...shop.cfg.notify, telegramToken: '' } }, accounts, codes });
  assert.equal(off.enabled(), false);
  assert.deepEqual(await off.sendToCustomer(1, 'x'), { ok: false, blocked: false });
  off.start();
  await off.stop();
});

test('фоновый опрос: подхватывает обновление и быстро останавливается', async () => {
  const b = createBot({ db: shop.db, cfg: shop.cfg, accounts, codes });
  const { token } = await b.createLink({ purpose: 'login' });
  tg.updates.push(startUpdate(token, { from: 950 }));
  b.start();
  b.start();                                                   // повторный запуск ничего не меняет
  let r;
  for (let i = 0; i < 40 && !(r = await row(token)).telegram_id; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(String(r.telegram_id), '950');
  const t0 = Date.now();
  await b.stop();
  assert.ok(Date.now() - t0 < 2000, 'остановка не ждёт конца паузы');
});
