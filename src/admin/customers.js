'use strict';
const { html } = require('../html');
const { icon } = require('../icons');
const { rub, num, plural, formatPhone, normalizePhone, clampInt, str } = require('../util');
const { STATUSES } = require('../orders');
const { NOT_VALID } = require('./stats');
const { pager, stat } = require('./layout');

const PAGE = 25;
const VIP_SUM = 100000;

// Сегмент клиента по выкупленным заказам
function segmentOf(orders, spent) {
  if (!orders) return { key: 'none', title: 'Без покупок' };
  if (orders >= 5 || spent >= VIP_SUM) return { key: 'vip', title: 'VIP' };
  if (orders >= 2) return { key: 'repeat', title: 'Постоянный' };
  return { key: 'new', title: 'Новый' };
}
const segChip = (s) => html`<span class="chip chip--seg-${s.key}">${s.title}</span>`;

const SORTS = {
  spent: ['Больше потратили', 'spent DESC, c.id DESC'],
  last: ['Недавно заказывали', 'last_order DESC NULLS LAST, c.id DESC'],
  orders: ['Больше заказов', 'orders DESC, spent DESC'],
  created: ['Новые клиенты', 'c.created_at DESC'],
};

module.exports = function mount({ db, auth, render, fmt, chip, router }) {
  router.get('/customers', auth.require('customers'), async (req, res, next) => {
    try {
      const q = str(req.query.q, 60);
      const seg = ['vip', 'repeat', 'new', 'none'].includes(req.query.seg) ? req.query.seg : '';
      const sort = SORTS[req.query.sort] ? req.query.sort : 'spent';
      const page = clampInt(req.query.page, 1, 10000, 1);
      const params = [NOT_VALID, VIP_SUM];
      const where = [];
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        params.push(like);
        const conds = [`c.name ILIKE $${params.length}`, `c.email ILIKE $${params.length}`];
        const digits = normalizePhone(q) || q.replace(/\D/g, '');
        if (digits.length >= 4) { params.push('%' + digits + '%'); conds.push(`c.phone LIKE $${params.length}`); }
        where.push('(' + conds.join(' OR ') + ')');
      }
      const having = { vip: '(COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) >= 5 OR COALESCE(SUM(o.total) FILTER (WHERE o.status <> ALL($1)), 0) >= $2)',
        repeat: '(COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) BETWEEN 2 AND 4 AND COALESCE(SUM(o.total) FILTER (WHERE o.status <> ALL($1)), 0) < $2)',
        new: '(COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) = 1 AND COALESCE(SUM(o.total) FILTER (WHERE o.status <> ALL($1)), 0) < $2)',
        none: 'COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) = 0' }[seg];
      const base = `FROM webshop.customers c LEFT JOIN webshop.orders o ON o.customer_id = c.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY c.id ${having ? 'HAVING ' + having : ''}`;
      const sel = `SELECT c.id, c.name, c.phone, c.email, c.created_at,
                    COUNT(o.id) FILTER (WHERE o.status <> ALL($1))::int AS orders, COALESCE(SUM(o.total) FILTER (WHERE o.status <> ALL($1)), 0) AS spent,
                    MAX(o.created_at) AS last_order, $2::numeric AS vip_sum`;
      const [rows, cnt, tot] = await Promise.all([
        db.query(`${sel} ${base} ORDER BY ${SORTS[sort][1]} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, params),
        db.query(`SELECT COUNT(*)::int AS n FROM (SELECT c.id, COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) AS n, COALESCE(SUM(o.total) FILTER (WHERE o.status <> ALL($1)), 0) >= $2 AS vip ${base}) t`, params),
        db.query(
          `SELECT COUNT(*)::int AS customers,
                  COUNT(*) FILTER (WHERE n >= 1)::int AS buyers, COUNT(*) FILTER (WHERE n >= 2)::int AS repeat,
                  COALESCE(SUM(s), 0) AS revenue,
                  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS fresh
             FROM (SELECT c.id, c.created_at, COUNT(o.id) FILTER (WHERE o.status <> ALL($1)) AS n, SUM(o.total) FILTER (WHERE o.status <> ALL($1)) AS s
                     FROM webshop.customers c LEFT JOIN webshop.orders o ON o.customer_id = c.id GROUP BY c.id) t`, [NOT_VALID]),
      ]);
      const t = tot.rows[0];
      const pages = Math.max(1, Math.ceil(cnt.rows[0].n / PAGE));
      const keep = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ q, seg, sort, ...o })) if (v) u.set(k, v); return u.toString(); };
      const body = html`
      <div class="stats stats--4">
        ${stat({ label: 'Клиентов всего', value: num(t.customers), note: `${t.fresh} новых за 30 дней` })}
        ${stat({ label: 'Сделали покупку', value: num(t.buyers), note: 'есть выкупленный или оплаченный заказ' })}
        ${stat({ label: 'Вернулись за повторной', value: t.buyers ? Math.round((t.repeat / t.buyers) * 100) + '%' : '0%', note: `${t.repeat} из ${t.buyers} покупателей` })}
        ${stat({ label: 'Средняя сумма на клиента', value: rub(t.buyers ? Number(t.revenue) / t.buyers : 0), note: 'за всё время' })}
      </div>
      <nav class="tabs" aria-label="Сегменты">
        ${[['', 'Все'], ['vip', 'VIP'], ['repeat', 'Постоянные'], ['new', 'Новые'], ['none', 'Без покупок']].map(([k, t2]) => html`<a class="${seg === k ? 'is-active' : ''}" href="/admin/customers?${keep({ seg: k, page: '' })}">${t2}</a>`)}
      </nav>
      <form class="filters" method="get" action="/admin/customers">
        ${seg ? html`<input type="hidden" name="seg" value="${seg}">` : ''}
        <label class="search"><input type="search" name="q" value="${q}" placeholder="Имя, телефон или почта">${icon('search')}</label>
        <select name="sort" data-autosubmit aria-label="Сортировка">${Object.entries(SORTS).map(([k, v]) => html`<option value="${k}" ${sort === k ? 'selected' : ''}>${v[0]}</option>`)}</select>
        <button class="btn" type="submit">Найти</button>
        ${q || seg ? html`<a class="link" href="/admin/customers">Сбросить</a>` : ''}
      </form>
      <section class="card">
        <header class="card__h"><p class="muted">Найдено: <b>${num(cnt.rows[0].n)}</b> ${plural(cnt.rows[0].n, 'клиент', 'клиента', 'клиентов')}. VIP: от 5 заказов или от ${rub(VIP_SUM)}</p></header>
        ${rows.rows.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>Клиент</th><th>Контакты</th><th>Сегмент</th><th class="num">Заказов</th><th class="num">Сумма</th><th class="num">Средний чек</th><th>Последний заказ</th></tr></thead><tbody>
          ${rows.rows.map((c) => { const sg = segmentOf(c.orders, Number(c.spent)); return html`<tr class="clickrow" data-href="/admin/customers/${c.id}">
            <td><a href="/admin/customers/${c.id}"><b>${c.name || 'Без имени'}</b></a></td>
            <td>${formatPhone(c.phone)}${c.email ? html`<br><small class="muted">${c.email}</small>` : ''}</td>
            <td>${segChip(sg)}</td><td class="num">${c.orders}</td><td class="num"><b>${rub(c.spent)}</b></td>
            <td class="num">${c.orders ? rub(Number(c.spent) / c.orders) : '-'}</td><td>${c.last_order ? fmt.date(c.last_order) : '-'}</td></tr>`; })}</tbody></table></div>
          ${pager('/admin/customers?' + keep({ page: '' }), page, pages)}` : html`<p class="empty-note">Клиентов по этим условиям нет.</p>`}
      </section>`;
      await render(req, res, 'customers', { title: 'Клиенты', body, wide: true });
    } catch (e) { next(e); }
  });

  router.get('/customers/:id', auth.require('customers'), async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const c = Number.isInteger(id) ? (await db.query('SELECT * FROM webshop.customers WHERE id = $1', [id])).rows[0] : null;
      if (!c) return render(req, res, 'customers', { title: 'Клиент не найден', body: html`<div class="card card--pad"><a class="btn" href="/admin/customers">К списку клиентов</a></div>` }, 404);
      const [orders, cities] = await Promise.all([
        db.query(
          `SELECT o.id, o.number, o.created_at, o.total, o.status, o.delivery_title, o.source,
                  (SELECT string_agg(title || ' (' || size || ')', ', ' ORDER BY id) FROM webshop.order_items WHERE order_id = o.id) AS items
             FROM webshop.orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC`, [id]),
        db.query("SELECT delivery_city AS city, COUNT(*)::int AS n FROM webshop.orders WHERE customer_id = $1 AND delivery_city <> '' GROUP BY 1 ORDER BY n DESC LIMIT 3", [id]),
      ]);
      const valid = orders.rows.filter((o) => !NOT_VALID.includes(o.status));
      const spent = valid.reduce((a, o) => a + Number(o.total), 0);
      const sg = segmentOf(valid.length, spent);
      const first = orders.rows[orders.rows.length - 1];
      const body = html`
      <div class="stats stats--4">
        ${stat({ label: 'Заказов', value: valid.length, note: orders.rows.length !== valid.length ? `ещё ${orders.rows.length - valid.length} отменено` : 'без отмен' })}
        ${stat({ label: 'Потратил', value: rub(spent), hero: false })}
        ${stat({ label: 'Средний чек', value: rub(valid.length ? spent / valid.length : 0) })}
        ${stat({ label: 'Клиент с', value: first ? fmt.date(first.created_at) : fmt.date(c.created_at), note: first ? `пришёл: ${({ direct: 'напрямую', search: 'из поиска', social: 'из соцсетей', referral: 'с другого сайта' })[first.source] || first.source || 'неизвестно'}` : '' })}
      </div>
      <div class="order">
        <div class="order__main"><section class="card"><header class="card__h"><h2>Заказы клиента</h2></header>
          ${orders.rows.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>№</th><th>Дата</th><th>Состав</th><th>Доставка</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>
            ${orders.rows.map((o) => html`<tr class="clickrow" data-href="/admin/orders/${o.id}"><td><a href="/admin/orders/${o.id}"><b>${o.number}</b></a></td><td>${fmt.dateTime(o.created_at)}</td><td class="cell-clip"><span>${o.items}</span></td><td>${o.delivery_title}</td><td class="num"><b>${rub(o.total)}</b></td><td>${chip(o.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty-note">Заказов нет.</p>`}</section></div>
        <aside class="order__side">
          <section class="card card--pad"><h2>${c.name || 'Без имени'}</h2><p>${segChip(sg)}</p>
            <p><a href="tel:+${c.phone}">${formatPhone(c.phone)}</a></p>${c.email ? html`<p><a href="mailto:${c.email}">${c.email}</a></p>` : ''}
            ${cities.rows.length ? html`<p class="muted">Города доставки: ${cities.rows.map((x) => x.city).join(', ')}</p>` : ''}</section>
          <section class="card card--pad"><h2>Заметка о клиенте</h2>
            <form method="post" action="/admin/customers/${c.id}/note">${req.adminCsrf}
              <label class="field"><span class="sr">Заметка</span><textarea name="note" rows="4" maxlength="1000" placeholder="Любит замшу, просит звонить после 18:00...">${c.note}</textarea></label>
              <button class="btn btn--block" type="submit">Сохранить</button></form></section>
        </aside>
      </div>`;
      await render(req, res, 'customers', { title: c.name || formatPhone(c.phone), body, wide: true, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/customers">${icon('chevron-left')} К списку</a>` });
    } catch (e) { next(e); }
  });

  router.post('/customers/:id/note', auth.require('customers'), async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      await db.query('UPDATE webshop.customers SET note = $2 WHERE id = $1', [id, str(req.body.note, 1000)]);
      res.flash('ok', 'Заметка сохранена');
      res.redirect(`/admin/customers/${id}`);
    } catch (e) { next(e); }
  });
};
