'use strict';
// Связь со складом: списание заказов.
//
// Остатки ведёт приложение «Склад». Заказ сайта, дошедший до статуса «Собран», ставится в очередь списания - таблицу
// order_writeoffs (source = 'site', account_id = 0, order_ref = номер заказа, lines = [{key: артикул, name, qty}]). Сотрудник
// списывает его в приложении («Заказы Маркета» → «Списать со склада…» → «Заказы сайта…»): остаток уменьшается одним
// документом «Списание», один раз. Отменили заказ: до списания он снимается с очереди (cancelled), после - ставится
// «ждёт возврата» (cancel_requested), и сотрудник возвращает пару приходом той же кнопкой. Формат таблицы и правила состояний -
// README приложения («Списание заказов со склада»); этот модуль их только соблюдает и ничего не списывает сам.
//
// Очередь согласуется «сверкой»: на запуске, раз в минуту и после смены статуса в админке одни и те же идемпотентные запросы
// приводят очередь в соответствие со статусами заказов. Поэтому ничего не теряется, если приложение ещё не обновлено или у сайта
// пока нет прав: как только таблица и права появятся, очередь догонит.

const STATE_TEXT = {
  pending: 'Ждёт списания: сотрудник спишет его в приложении «Склад»',
  writing: 'Списывается в приложении прямо сейчас',
  written_off: 'Списан со склада',
  cancel_requested: 'Заказ отменён после списания: ждёт возврата пары на склад в приложении',
  returning: 'Пара возвращается на склад',
  returned: 'Пара возвращена на склад',
  cancelled: 'Снят с очереди списания (отменён до списания)',
};
const ENQUEUE_STATUSES = ['packed', 'shipped', 'delivered'];

function createWriteoff(db, { intervalMs = 60_000 } = {}) {
  const self = {
    state: { status: 'unknown', lastSync: null, queued: 0, cancelled: 0, message: '' },
    stateText: STATE_TEXT,
  };
  let timer = null;
  let running = null;

  const classify = (e) => (e.code === '42P01' ? 'missing' : e.code === '42501' ? 'denied' : 'error');
  const MESSAGES = {
    missing: 'в базе нет таблицы order_writeoffs: запустите новую версию приложения «Склад» один раз',
    denied: 'у пользователя сайта нет прав на order_writeoffs: выполните grants.sql',
    error: 'очередь списания сейчас недоступна (см. журнал сайта)',
  };

  // С какого момента отправленные и полученные заказы ставятся в очередь. Заказы, которые были отправлены ДО подключения
  // очереди, в ней не нужны: их пары давно ушли со склада (возможно, уже списаны вручную), второй раз списывать нельзя.
  async function enabledAt() {
    await db.query(
      `INSERT INTO webshop.settings (key, value) VALUES ('writeoffEnabledAt', to_jsonb(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
       ON CONFLICT (key) DO NOTHING`);
    const { rows } = await db.query("SELECT value #>> '{}' AS v FROM webshop.settings WHERE key = 'writeoffEnabledAt'");
    return rows[0].v;
  }

  async function runSync() {
    try {
      await db.query('SELECT 1 FROM order_writeoffs LIMIT 0'); // есть ли таблица и право читать
      const since = await enabledAt();
      // 1. Поставить в очередь заказы «Собран», а также «Отправлен»/«Получен», изменённые уже после подключения очереди
      const q = await db.query(
        `INSERT INTO order_writeoffs (source, account_id, order_ref, state, lines)
         SELECT 'site', 0, o.number, 'pending',
                (SELECT jsonb_agg(jsonb_build_object('key', i.sku, 'name', i.title, 'qty', i.qty) ORDER BY i.id)
                   FROM webshop.order_items i WHERE i.order_id = o.id)
           FROM webshop.orders o
          WHERE (o.status = 'packed' OR (o.status = ANY($1) AND o.updated_at >= $2::timestamptz))
            AND EXISTS (SELECT 1 FROM webshop.order_items i WHERE i.order_id = o.id)
         ON CONFLICT (source, account_id, order_ref) DO NOTHING`, [ENQUEUE_STATUSES, since]);
      // 2. Заказ вернули в работу после отмены (до списания): снова в очередь
      const reopened = await db.query(
        `UPDATE order_writeoffs w SET state = 'pending'
           FROM webshop.orders o
          WHERE w.source = 'site' AND w.account_id = 0 AND w.order_ref = o.number AND w.state = 'cancelled' AND o.status = ANY($1)`,
        [ENQUEUE_STATUSES]);
      // 3. Заказ отменён или возвращён: до списания снять с очереди, после списания - попросить вернуть пару на склад
      const cancelled = await db.query(
        `UPDATE order_writeoffs w
            SET state = CASE w.state WHEN 'pending' THEN 'cancelled' ELSE 'cancel_requested' END
           FROM webshop.orders o
          WHERE w.source = 'site' AND w.account_id = 0 AND w.order_ref = o.number
            AND o.status IN ('cancelled', 'returned') AND w.state IN ('pending', 'written_off')`);
      self.state = { status: 'ok', lastSync: new Date(), queued: q.rowCount + reopened.rowCount, cancelled: cancelled.rowCount, message: '' };
    } catch (e) {
      const status = classify(e);
      if (self.state.status !== status) console.warn(`[writeoff] очередь списания недоступна (${status}): ${e.message}`);
      self.state = { status, lastSync: new Date(), queued: 0, cancelled: 0, message: MESSAGES[status] };
    }
    return self.state;
  }

  // Одновременно выполняется одна сверка: два запроса подряд получают результат уже идущей
  self.sync = () => {
    if (!running) running = runSync().finally(() => { running = null; });
    return running;
  };

  // Состояние очереди по номерам заказов: Map(номер -> state)
  self.states = async (numbers) => {
    if (!numbers.length || self.state.status === 'missing' || self.state.status === 'denied') return new Map();
    try {
      const { rows } = await db.query(
        "SELECT order_ref, state FROM order_writeoffs WHERE source = 'site' AND account_id = 0 AND order_ref = ANY($1)", [numbers.map(String)]);
      return new Map(rows.map((r) => [r.order_ref, r.state]));
    } catch { return new Map(); }
  };

  // Сколько заказов ждёт списания (для сводки)
  self.pendingCount = async () => {
    if (self.state.status !== 'ok') return null;
    try {
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM order_writeoffs WHERE source = 'site' AND account_id = 0 AND state = 'pending'");
      return rows[0].n;
    } catch { return null; }
  };

  self.start = () => {
    if (timer) return;
    timer = setInterval(() => { self.sync().catch(() => {}); }, intervalMs);
    timer.unref();
  };
  self.stop = () => { if (timer) clearInterval(timer); timer = null; };
  return self;
}

module.exports = { createWriteoff, STATE_TEXT };
