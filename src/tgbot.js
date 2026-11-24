'use strict';
// Telegram-бот для покупателей: вход и привязка по коду, команды, сообщения о статусе заказа.
// Бот сам опрашивает Telegram (getUpdates, «длинный опрос»): так он работает без домена и HTTPS. Рассылка сотрудникам
// (src/notify.js) устроена отдельно и от бота не зависит.
//
// Вход: сайт создаёт ссылку t.me/<бот>?start=L<токен>. Покупатель открывает бота, жмёт «Поделиться номером»; бот проверяет,
// что контакт принадлежит самому пишущему (contact.user_id == from.id), и присылает 6-значный код, который вводят на сайте.
// Код, а не автоматический вход: иначе злоумышленник мог бы прислать жертве свою ссылку и войти под её номером.
const crypto = require('crypto');
const { normalizePhone } = require('./util');
const { CodeError } = require('./auth-codes');

const LINK_TTL_MIN = 15;
const REQUEST_TIMEOUT_MS = 8000;

const HELP = 'Это бот магазина. Он присылает коды для входа на сайт и сообщает о статусе заказов. Чтобы войти, нажмите «Войти через Telegram» на сайте.';
const STALE = 'Ссылка устарела или уже использована. Вернитесь на сайт и нажмите «Войти через Telegram» заново.';
const NEED_OWN = 'Нужен ваш собственный номер. Нажмите кнопку «Поделиться номером» под полем ввода.';
const NEED_START = 'Сначала откройте на сайте кнопку «Войти через Telegram» и перейдите по ссылке сюда.';
const NOT_RU = 'Пока мы работаем только с российскими номерами.';
const NOT_LINKED = 'Этот Telegram пока не привязан к аккаунту на сайте. Войдите на сайт и нажмите «Привязать Telegram» в кабинете.';

function createBot({ db, cfg, accounts, codes, fetchImpl = fetch, log = console }) {
  const n = cfg.notify || {};
  const token = n.telegramToken || '';
  const apiBase = n.telegramApi || 'https://api.telegram.org';
  const state = { offset: 0, running: false, loop: null, abort: null, wake: null, name: n.telegramBotUsername || '' };

  const enabled = () => Boolean(token);
  // Токен бота - секрет: в сообщения об ошибках и в журнал он не попадает
  const scrub = (s) => (token ? String(s || '').split(token).join('***') : String(s || ''));

  async function call(method, body = {}, { timeoutMs = REQUEST_TIMEOUT_MS, signal = null } = {}) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any(signals),
      });
    } catch (e) {
      return { status: 0, ok: false, data: null, error: scrub(`${e.message}${e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''}`) };
    }
    let data = null;
    try { data = await res.json(); } catch { /* ответ не JSON */ }
    return { status: res.status, ok: Boolean(res.ok && data && data.ok), data };
  }
  const reply = (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra });

  // Имя бота для ссылки: из TELEGRAM_BOT_USERNAME или у Telegram (getMe), запоминается
  async function username() {
    if (state.name) return state.name;
    const r = await call('getMe');
    const u = r.ok && r.data.result && r.data.result.username;
    if (!u) throw new Error('Не удалось узнать имя бота: проверьте TELEGRAM_BOT_TOKEN');
    state.name = u;
    return u;
  }

  const linkUrl = async (tok, purpose) => `https://t.me/${await username()}?start=${purpose === 'link' ? 'K' : 'L'}${tok}`;

  // purpose: 'login' - вход (customerId не нужен), 'link' - привязка Telegram к аккаунту customerId
  async function createLink({ purpose, customerId = null }) {
    const tok = crypto.randomBytes(18).toString('base64url');
    await db.query(
      'INSERT INTO webshop.tg_login (token, purpose, customer_id, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))',
      [tok, purpose, customerId, LINK_TTL_MIN]);
    db.query("DELETE FROM webshop.tg_login WHERE created_at < NOW() - INTERVAL '2 days'").catch(() => {});
    return { token: tok, url: await linkUrl(tok, purpose) };
  }

  async function sendCode(tok, chatId) {
    try {
      const { code } = await codes.issue({ purpose: 'tg', channel: 'tg', target: tok });
      await reply(chatId, `Код для входа: ${code}\nДействует 10 минут. Никому не сообщайте этот код.`, { reply_markup: { remove_keyboard: true } });
    } catch (e) {
      if (!(e instanceof CodeError)) throw e;
      await reply(chatId, 'Код уже отправлен. Подождите минуту и попробуйте ещё раз.');
    }
  }

  async function onStart(m, param) {
    const chat = m.chat.id;
    if (!param) return reply(chat, HELP);
    const mt = /^([LK])([A-Za-z0-9_-]{16,64})$/.exec(param);
    if (!mt) return reply(chat, STALE);
    const purpose = mt[1] === 'K' ? 'link' : 'login';
    const { rows } = await db.query(
      'SELECT * FROM webshop.tg_login WHERE token = $1 AND purpose = $2 AND expires_at > NOW() AND consumed_at IS NULL', [mt[2], purpose]);
    const row = rows[0];
    // Ссылка занята другим пользователем Telegram: чужую не перехватываем
    if (!row || (row.telegram_id !== null && String(row.telegram_id) !== String(m.from.id))) return reply(chat, STALE);
    if (row.phone) return sendCode(row.token, chat);                    // повторное нажатие: контакт уже был
    if (purpose === 'login') {
      const linked = (await db.query('SELECT phone FROM webshop.customers WHERE telegram_id = $1', [m.from.id])).rows[0];
      if (linked) {                                                      // Telegram уже привязан: контакт не нужен
        await db.query('UPDATE webshop.tg_login SET phone = $2, telegram_id = $3 WHERE token = $1', [row.token, linked.phone, m.from.id]);
        return sendCode(row.token, chat);
      }
    }
    await db.query('UPDATE webshop.tg_login SET telegram_id = $2 WHERE token = $1', [row.token, m.from.id]);
    return reply(chat, 'Нажмите кнопку «Поделиться номером», чтобы подтвердить телефон. Мы пришлём код для входа на сайт.', {
      reply_markup: { keyboard: [[{ text: 'Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }

  async function onContact(m) {
    const chat = m.chat.id;
    const c = m.contact;
    if (Number(c.user_id) !== Number(m.from.id)) return reply(chat, NEED_OWN);   // чужой контакт или набранный вручную
    const { rows } = await db.query(
      `SELECT * FROM webshop.tg_login WHERE telegram_id = $1 AND phone IS NULL AND expires_at > NOW() AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`, [m.from.id]);
    const row = rows[0];
    if (!row) return reply(chat, NEED_START);
    const phone = normalizePhone(c.phone_number);
    if (!phone) return reply(chat, NOT_RU);
    if (row.purpose === 'link') {
      const cust = await accounts.byId(row.customer_id);
      if (!cust || cust.phone !== phone) return reply(chat, 'Номер этого Telegram не совпадает с номером аккаунта на сайте. Привязать можно только Telegram с тем же номером.');
    }
    await db.query('UPDATE webshop.tg_login SET phone = $2 WHERE token = $1', [row.token, phone]);
    return sendCode(row.token, chat);
  }

  async function onToggle(m, on) {
    const { rowCount } = await db.query('UPDATE webshop.customers SET tg_notify = $2 WHERE telegram_id = $1', [m.from.id, on]);
    if (!rowCount) return reply(m.chat.id, NOT_LINKED);
    return reply(m.chat.id, on ? 'Уведомления о заказах включены.' : 'Уведомления о заказах выключены. Чтобы включить снова, отправьте /notify.');
  }

  // Обрабатывает одно обновление Telegram; всё, что не личное сообщение, игнорируется
  async function handleUpdate(update) {
    const m = update && update.message;
    if (!m || !m.from || !m.chat || m.chat.type !== 'private') return;
    if (m.contact) return onContact(m);
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?/.exec(String(m.text || '').trim());
    if (!cmd) return;
    if (cmd[1] === 'start') return onStart(m, cmd[2] || '');
    if (cmd[1] === 'stop') return onToggle(m, false);
    if (cmd[1] === 'notify') return onToggle(m, true);
  }

  // Сообщение покупателю. blocked: покупатель заблокировал бота (HTTP 403), слать ему больше не нужно.
  async function sendToCustomer(telegramId, text) {
    if (!enabled()) return { ok: false, blocked: false };
    const r = await reply(telegramId, text);
    return { ok: r.ok, blocked: r.status === 403 };
  }

  // Один запрос getUpdates: число обработанных обновлений, 'conflict' (опрашивает другой процесс) или 'error'
  async function pollOnce(timeoutSec = 25) {
    const r = await call('getUpdates', { offset: state.offset, timeout: timeoutSec, allowed_updates: ['message'] },
      { timeoutMs: (timeoutSec + 10) * 1000, signal: state.abort && state.abort.signal });
    if (r.status === 409) return 'conflict';
    if (!r.ok || !Array.isArray(r.data.result)) return 'error';
    let handled = 0;
    for (const u of r.data.result) {
      try { await handleUpdate(u); } catch (e) { log.error('[tgbot]', scrub(e.message)); }
      state.offset = Math.max(state.offset, u.update_id + 1);
      handled++;
    }
    return handled;
  }

  const nap = (ms) => new Promise((resolve) => { state.wake = resolve; setTimeout(resolve, ms).unref(); });

  function start() {
    if (!enabled() || state.running) return;
    state.running = true;
    state.abort = new AbortController();
    state.loop = (async () => {
      while (state.running) {
        const t0 = Date.now();
        let r;
        try { r = await pollOnce(); } catch (e) { log.error('[tgbot]', scrub(e.message)); r = 'error'; }
        if (!state.running) break;
        if (r === 'conflict') await nap(30_000);                       // второй процесс опрашивает тот же токен
        else if (r === 'error') await nap(5000);
        else if (Date.now() - t0 < 1000) await nap(1000);              // быстрый ответ без обновлений: не крутимся вхолостую
      }
    })();
  }

  async function stop() {
    state.running = false;
    if (state.abort) state.abort.abort();
    if (state.wake) state.wake();
    if (state.loop) await state.loop.catch(() => {});
    state.loop = null;
  }

  // Имя бота, если оно уже известно (из настройки или после первой ссылки входа): без запроса к Telegram
  const knownName = () => state.name;

  return { enabled, username, knownName, linkUrl, createLink, handleUpdate, pollOnce, start, stop, sendToCustomer };
}

module.exports = { createBot };
