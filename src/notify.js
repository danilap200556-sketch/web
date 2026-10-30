'use strict';
// Уведомления о новых заказах (Telegram). Заказ кладёт запись в webshop.outbox в той же транзакции, что и сам заказ, поэтому
// уведомление не теряется, даже если Telegram недоступен или сайт перезапустили: фоновая отправка повторяет попытки с нарастающей
// паузой (30 с, 2 мин, 10 мин, 30 мин, дальше раз в час, всего 14 попыток, около суток). Сбой уведомления заказ не задерживает и не отменяет.
const { rub, formatPhone } = require('./util');
const { PAY_METHODS } = require('./delivery');

const BACKOFF_SEC = [30, 120, 600, 1800, 3600];
const MAX_ATTEMPTS = 14;
const LEASE_SEC = 120;        // пока строку отправляет один процесс, другой её не берёт; при обрыве попытка повторится через 2 минуты
const SEND_TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createNotifier({ db, cfg, log = console }) {
  const n = cfg.notify || {};
  const token = n.telegramToken || '';
  const chats = n.telegramChatIds || [];
  const api = n.telegramApi || 'https://api.telegram.org';
  const siteUrl = cfg.publicUrl || '';
  const state = { running: false, timer: null };

  const enabled = () => Boolean(token && chats.length);
  // Токен бота - секрет: в сообщения об ошибках и в журнал он не попадает
  const scrub = (s) => (token ? String(s || '').split(token).join('***') : String(s || ''));

  async function sendTelegram(text) {
    const results = [];
    for (const chat of chats) {
      try {
        const res = await fetch(`${api}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        let data = null;
        try { data = await res.json(); } catch { /* ответ не JSON */ }
        if (res.ok && data && data.ok) results.push({ chat, ok: true });
        else results.push({ chat, ok: false, error: scrub(`HTTP ${res.status}${data && data.description ? ': ' + data.description : ''}`) });
      } catch (e) {
        const why = e && e.name === 'TimeoutError' ? `нет ответа за ${SEND_TIMEOUT_MS / 1000} с` : `${e.message}${e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''}`;
        results.push({ chat, ok: false, error: scrub(why) });
      }
    }
    return results;
  }

  async function orderText(orderId) {
    const { rows } = await db.query('SELECT * FROM webshop.orders WHERE id = $1', [orderId]);
    const o = rows[0];
    if (!o) return null;
    const items = (await db.query('SELECT title, size, price, qty FROM webshop.order_items WHERE order_id = $1 ORDER BY id', [orderId])).rows;
    const lines = [`Новый заказ №${o.number} на ${rub(Number(o.total))}`, ''];
    lines.push(`Клиент: ${o.name}, ${formatPhone(o.phone)}${o.email ? ', ' + o.email : ''}`);
    const where = o.delivery_kind === 'pickup' ? '' : [o.delivery_city, o.delivery_point || o.delivery_address].filter(Boolean).join(', ');
    lines.push(`Доставка: ${o.delivery_title}${where ? ' · ' + where : ''}${Number(o.delivery_cost) ? ` (${rub(Number(o.delivery_cost))})` : ''}`);
    lines.push(`Оплата: ${(PAY_METHODS[o.pay_method] || {}).title || o.pay_method}`);
    lines.push('', 'Состав:');
    for (const i of items) lines.push(`• ${i.title} · ${i.size} × ${i.qty} - ${rub(Number(i.price) * i.qty)}`);
    if (o.comment) lines.push('', `Комментарий: ${o.comment}`);
    if (siteUrl) lines.push('', `${siteUrl}/admin/orders/${o.id}`);
    return lines.join('\n');
  }

  async function deliver(row) {
    const text = await orderText(row.order_id);
    if (text === null) { // заказа уже нет - слать нечего
      await db.query("UPDATE webshop.outbox SET sent_at = NOW(), error = 'заказ не найден' WHERE id = $1", [row.id]);
      return;
    }
    const res = await sendTelegram(text);
    const failed = res.filter((r) => !r.ok);
    if (res.some((r) => r.ok)) {
      // Хотя бы один чат получил: не повторяем, чтобы остальные не получили дубль
      await db.query('UPDATE webshop.outbox SET sent_at = NOW(), error = $2 WHERE id = $1', [row.id, failed.map((r) => `${r.chat}: ${r.error}`).join('; ')]);
    } else {
      const wait = BACKOFF_SEC[Math.min(row.attempts - 1, BACKOFF_SEC.length - 1)];
      const error = failed.map((r) => `${r.chat}: ${r.error}`).join('; ');
      await db.query('UPDATE webshop.outbox SET next_at = NOW() + make_interval(secs => $2), error = $3 WHERE id = $1', [row.id, wait, error]);
      log.warn(`[notify] заказ ${row.order_id}: не доставлено (попытка ${row.attempts}): ${error}`);
    }
  }

  // Берёт готовые к отправке строки (с «арендой», чтобы два процесса не слали одно и то же) и отправляет
  async function run() {
    if (state.running || !enabled()) return;
    state.running = true;
    try {
      for (let guard = 0; guard < 20; guard++) {
        const { rows } = await db.query(
          `UPDATE webshop.outbox SET attempts = attempts + 1, next_at = NOW() + make_interval(secs => $1)
            WHERE id IN (SELECT id FROM webshop.outbox WHERE sent_at IS NULL AND attempts < $2 AND next_at <= NOW()
                          ORDER BY id LIMIT 5 FOR UPDATE SKIP LOCKED)
            RETURNING id, kind, order_id, attempts`, [LEASE_SEC, MAX_ATTEMPTS]);
        if (!rows.length) break;
        for (const row of rows) {
          try { await deliver(row); } catch (e) { log.error('[notify]', scrub(e.message)); }
        }
      }
    } catch (e) {
      log.error('[notify]', scrub(e.message));
    } finally {
      state.running = false;
    }
  }

  return {
    enabled,
    chatCount: () => chats.length,

    // В транзакции заказа: запись в очередь. Без настроенного Telegram ничего не пишет.
    async enqueue(client, orderId) {
      if (enabled()) await client.query("INSERT INTO webshop.outbox (kind, order_id) VALUES ('order_new', $1)", [orderId]);
    },
    // После фиксации заказа: отправить сразу, не заставляя покупателя ждать
    kick() { if (enabled()) setImmediate(() => { run(); }); },
    run,
    start({ intervalMs = 30_000 } = {}) {
      if (!enabled() || state.timer) return;
      state.timer = setInterval(() => { run(); }, intervalMs);
      state.timer.unref();
      db.query("DELETE FROM webshop.outbox WHERE sent_at < NOW() - INTERVAL '60 days'").catch(() => {});
      run();
    },
    async stop() {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      for (let i = 0; i < 100 && state.running; i++) await sleep(50);
    },

    async test() {
      const shop = (cfg.shopName || 'Магазин');
      return sendTelegram(`Проверка уведомлений: магазин «${shop}» подключён к этому чату. Сюда будут приходить новые заказы.`);
    },

    async status() {
      const { rows } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts < $1)::int AS waiting,
                COUNT(*) FILTER (WHERE sent_at IS NULL AND attempts >= $1)::int AS failed,
                MAX(sent_at) AS last_sent,
                (SELECT error FROM webshop.outbox WHERE sent_at IS NULL AND error <> '' ORDER BY id DESC LIMIT 1) AS last_error
           FROM webshop.outbox`, [MAX_ATTEMPTS]);
      return { enabled: enabled(), chats: chats.length, ...rows[0] };
    },
  };
}

module.exports = { createNotifier, MAX_ATTEMPTS };
