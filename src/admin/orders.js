'use strict';
const { html } = require('../html');
const { icon } = require('../icons');
const { rub, num, plural, formatPhone, normalizePhone, clampInt, str } = require('../util');
const { STATUSES, FLOW } = require('../orders');
const { PAY_METHODS } = require('../delivery');
const { photoUrl } = require('../shopviews');
const { pager } = require('./layout');

const PAGE = 25;
const NEXT_LABEL = { new: 'Подтвердить заказ', confirmed: 'Отметить оплаченным', paid: 'Отметить собранным', packed: 'Отметить отправленным', shipped: 'Отметить полученным' };

module.exports = function mount({ db, auth, render, fmt, chip, router, catalog, writeoff }) {
  // ---------- Список ----------
  router.get('/orders', auth.require('orders'), async (req, res, next) => {
    try {
      const status = STATUSES[req.query.status] ? req.query.status : '';
      const q = str(req.query.q, 60);
      const range = ['7', '30', '90'].includes(req.query.range) ? parseInt(req.query.range, 10) : 0;
      const delivery = ['pickup', 'courier', 'tc'].includes(req.query.delivery) ? req.query.delivery : '';
      const page = clampInt(req.query.page, 1, 10000, 1);
      const where = [];
      const params = [];
      const p = (v) => { params.push(v); return `$${params.length}`; };
      if (status) where.push(`o.status = ${p(status)}`);
      if (delivery) where.push(`o.delivery_kind = ${p(delivery)}`);
      if (range) where.push(`o.created_at >= NOW() - make_interval(days => ${p(range)})`);
      if (q) {
        const digits = normalizePhone(q) || q.replace(/\D/g, '');
        const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        const conds = [`o.number = ${p(q.replace(/^№\s*/, ''))}`, `o.name ILIKE ${p(like)}`, `o.email ILIKE ${p(like)}`];
        if (digits.length >= 4) conds.push(`o.phone LIKE ${p('%' + digits + '%')}`);
        where.push('(' + conds.join(' OR ') + ')');
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [counts, total, rows] = await Promise.all([
        db.query('SELECT status, COUNT(*)::int AS n FROM webshop.orders GROUP BY status'),
        db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(o.total), 0) AS sum FROM webshop.orders o ${w}`, params),
        db.query(
          `SELECT o.id, o.number, o.created_at, o.name, o.phone, o.total, o.status, o.delivery_title, o.pay_method,
                  (SELECT COALESCE(SUM(qty), 0)::int FROM webshop.order_items WHERE order_id = o.id) AS qty,
                  (SELECT title FROM webshop.order_items WHERE order_id = o.id ORDER BY id LIMIT 1) AS first_title
             FROM webshop.orders o ${w} ORDER BY o.created_at DESC, o.id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, params),
      ]);
      const cm = new Map(counts.rows.map((r) => [r.status, r.n]));
      const all = counts.rows.reduce((a, r) => a + r.n, 0);
      const pages = Math.max(1, Math.ceil(total.rows[0].n / PAGE));
      const keep = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ status, q, range: range || '', delivery, ...o })) if (v) u.set(k, v); return u.toString(); };
      const body = html`
      <nav class="tabs" aria-label="Статусы">
        <a class="${!status ? 'is-active' : ''}" href="/admin/orders?${keep({ status: '' })}">Все <b>${all}</b></a>
        ${Object.entries(STATUSES).map(([k, s]) => html`<a class="${status === k ? 'is-active' : ''}" href="/admin/orders?${keep({ status: k })}">${s.title} <b>${cm.get(k) || 0}</b></a>`)}
      </nav>
      <form class="filters" method="get" action="/admin/orders">
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <label class="search"><input type="search" name="q" value="${q}" placeholder="№ заказа, имя, телефон или почта">${icon('search')}</label>
        <select name="range" data-autosubmit aria-label="Период"><option value="">За всё время</option>${[['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней']].map(([v, t]) => html`<option value="${v}" ${String(range) === v ? 'selected' : ''}>${t}</option>`)}</select>
        <select name="delivery" data-autosubmit aria-label="Доставка"><option value="">Любая доставка</option>${[['pickup', 'Самовывоз'], ['courier', 'Курьер'], ['tc', 'Транспортная компания']].map(([v, t]) => html`<option value="${v}" ${delivery === v ? 'selected' : ''}>${t}</option>`)}</select>
        <button class="btn" type="submit">Найти</button>
        ${status || q || range || delivery ? html`<a class="link" href="/admin/orders">Сбросить</a>` : ''}
      </form>
      <section class="card">
        <header class="card__h"><p class="muted">Найдено: <b>${num(total.rows[0].n)}</b> ${plural(total.rows[0].n, 'заказ', 'заказа', 'заказов')} на сумму <b>${rub(total.rows[0].sum)}</b></p></header>
        ${rows.rows.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>№</th><th>Дата</th><th>Клиент</th><th>Состав</th><th>Доставка</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>
          ${rows.rows.map((o) => html`<tr class="clickrow" data-href="/admin/orders/${o.id}">
            <td><a href="/admin/orders/${o.id}"><b>${o.number}</b></a></td>
            <td>${fmt.dateTime(o.created_at)}</td>
            <td><b>${o.name}</b><br><small class="muted">${formatPhone(o.phone)}</small></td>
            <td class="cell-clip"><span>${o.first_title}</span><br><small class="muted">${o.qty} ${plural(o.qty, 'товар', 'товара', 'товаров')} · ${PAY_METHODS[o.pay_method]?.title.split(':')[0] || o.pay_method}</small></td>
            <td>${o.delivery_title}</td>
            <td class="num"><b>${rub(o.total)}</b></td>
            <td>${chip(o.status)}</td></tr>`)}</tbody></table></div>
          ${pager('/admin/orders?' + keep({}), page, pages)}` : html`<p class="empty-note">Заказов по этим условиям нет.</p>`}
      </section>`;
      await render(req, res, 'orders', { title: 'Заказы', body, wide: true });
    } catch (e) { next(e); }
  });

  // ---------- Карточка заказа ----------
  async function loadOrder(id) {
    const o = (await db.query('SELECT * FROM webshop.orders WHERE id = $1', [id])).rows[0];
    if (!o) return null;
    const [items, events, cust] = await Promise.all([
      db.query('SELECT * FROM webshop.order_items WHERE order_id = $1 ORDER BY id', [id]),
      db.query('SELECT * FROM webshop.order_events WHERE order_id = $1 ORDER BY at DESC, id DESC', [id]),
      db.query(`SELECT c.id, c.name, c.email, (SELECT COUNT(*)::int FROM webshop.orders WHERE customer_id = c.id) AS orders FROM webshop.customers c WHERE c.id = $1`, [o.customer_id]),
    ]);
    return { ...o, items: items.rows, events: events.rows, customer: cust.rows[0] || null };
  }

  router.get('/orders/:id', auth.require('orders'), async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const o = Number.isInteger(id) ? await loadOrder(id) : null;
      if (!o) return render(req, res, 'orders', { title: 'Заказ не найден', body: html`<div class="card card--pad"><p>Такого заказа нет.</p><a class="btn" href="/admin/orders">К списку заказов</a></div>` }, 404);
      const st = STATUSES[o.status];
      const next_ = FLOW[FLOW.indexOf(o.status) + 1];
      const publicUrl = `/order/${o.number}?t=${o.token}`;
      const wstate = (await writeoff.states([o.number])).get(o.number);
      const body = html`
      <div class="order">
        <div class="order__main">
          <section class="card card--pad order__status">
            <div class="order__stepper"><ol class="steps">${FLOW.map((k) => { const s = STATUSES[k]; const done = st.step >= s.step && st.step >= 0; return html`<li class="${done ? 'is-done' : ''}${o.status === k ? ' is-now' : ''}"><span>${done ? icon('check') : ''}</span>${s.title}</li>`; })}</ol></div>
            ${o.status === 'cancelled' || o.status === 'returned' ? html`<p class="flash flash--err">Заказ ${st.title.toLowerCase()}: товар снова доступен к продаже</p>` : ''}
            <div class="order__actions">
              <form method="post" action="/admin/orders/${o.id}/status" class="inline">
                ${req.adminCsrf}
                ${next_ ? html`<button class="btn btn--primary" name="status" value="${next_}">${NEXT_LABEL[o.status]}</button>` : ''}
                <label class="field field--inline"><span class="sr">Статус</span>
                  <select name="status" aria-label="Любой статус">${Object.entries(STATUSES).map(([k, s]) => html`<option value="${k}" ${o.status === k ? 'selected' : ''}>${s.title}</option>`)}</select></label>
                <input class="note-in" name="note" placeholder="Комментарий к смене статуса (необязательно)" maxlength="300">
                <button class="btn" type="submit">Сменить статус</button>
              </form>
            </div>
            ${o.status === 'packed' && wstate === 'pending' ? html`<p class="hint">Заказ собран и стоит в очереди списания. Спишите пары со склада в приложении «Склад»: вкладка «Заказы Маркета» → «Списать со склада…» → «Заказы сайта…».</p>` : ''}
          </section>

          <section class="card">
            <header class="card__h"><h2>Состав заказа</h2></header>
            <div class="tablewrap"><table class="table"><thead><tr><th>Товар</th><th>Размер</th><th class="num">Цена</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead><tbody>
              ${o.items.map((i) => html`<tr><td><div class="prod">${i.photo_id ? html`<img src="${photoUrl(i.photo_id, 360)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="toplist__ph"></span>`}<div><b>${i.title}</b><small class="muted">${i.type} · арт. ${i.sku}</small></div></div></td>
                <td>${i.size}</td><td class="num">${rub(i.price)}</td><td class="num">${i.qty}</td><td class="num"><b>${rub(Number(i.price) * i.qty)}</b></td></tr>`)}
            </tbody><tfoot>
              <tr><td colspan="4" class="num muted">Товары</td><td class="num">${rub(o.subtotal)}</td></tr>
              <tr><td colspan="4" class="num muted">${o.delivery_title}</td><td class="num">${Number(o.delivery_cost) ? rub(o.delivery_cost) : 'бесплатно'}</td></tr>
              <tr class="tot"><td colspan="4" class="num">Итого</td><td class="num">${rub(o.total)}</td></tr></tfoot></table></div>
          </section>

          <section class="card card--pad">
            <h2>История</h2>
            <form method="post" action="/admin/orders/${o.id}/note" class="inline inline--grow">${req.adminCsrf}
              <input name="note" placeholder="Добавить заметку: созвонились, клиент просит перенести..." maxlength="500" required>
              <button class="btn" type="submit">Записать</button></form>
            <ol class="timeline">${o.events.map((e) => html`<li class="timeline__${e.kind}"><time>${fmt.dateTime(e.at)}</time><div>${e.text}${e.admin_name ? html` <small class="muted">· ${e.admin_name}</small>` : ''}</div></li>`)}</ol>
          </section>
        </div>

        <aside class="order__side">
          <section class="card card--pad">
            <h2>Клиент</h2>
            <p class="big">${o.name}</p>
            <p><a href="tel:+${o.phone}">${formatPhone(o.phone)}</a></p>
            ${o.email ? html`<p><a href="mailto:${o.email}">${o.email}</a></p>` : ''}
            ${o.customer ? html`<p class="muted">Заказов у клиента: <b>${o.customer.orders}</b> · <a href="/admin/customers/${o.customer.id}">карточка клиента</a></p>` : ''}
            ${o.source ? html`<p class="muted">Пришёл: ${({ direct: 'напрямую', search: 'из поиска', social: 'из соцсетей', referral: 'с другого сайта' })[o.source] || 'метка ' + o.source}</p>` : ''}
          </section>
          <section class="card card--pad">
            <h2>Доставка</h2>
            <dl class="facts">
              <dt>Способ</dt><dd>${o.delivery_title}</dd>
              ${o.delivery_city ? html`<dt>Город</dt><dd>${o.delivery_city}</dd>` : ''}
              <dt>${o.delivery_kind === 'pickup' ? 'Пункт самовывоза' : o.delivery_door ? 'Адрес' : 'Пункт выдачи'}</dt><dd>${o.delivery_address || o.delivery_point}</dd>
              ${o.delivery_meta ? html`<dt>Расчёт по API</dt><dd>${o.delivery_meta.tariff || 'тариф ' + o.delivery_meta.tariffCode}: ${rub(o.delivery_meta.apiPrice)}${o.delivery_meta.etaMax ? `, ${o.delivery_meta.etaMin === o.delivery_meta.etaMax ? o.delivery_meta.etaMin : o.delivery_meta.etaMin + '-' + o.delivery_meta.etaMax} дн.` : ''}
                <small class="muted">город №${o.delivery_meta.cityCode}${o.delivery_meta.pointCode ? ', пункт ' + o.delivery_meta.pointCode : ''}, тариф ${o.delivery_meta.tariffCode}</small></dd>` : ''}
              <dt>Стоимость</dt><dd>${Number(o.delivery_cost) ? rub(o.delivery_cost) : 'бесплатно'}</dd>
            </dl>
            <form method="post" action="/admin/orders/${o.id}/track" class="inline inline--grow">${req.adminCsrf}
              <input name="track" value="${o.track_number}" placeholder="Трек-номер" maxlength="60"><button class="btn" type="submit">Сохранить</button></form>
          </section>
          <section class="card card--pad">
            <h2>Склад</h2>
            ${wstate ? html`<p><span class="chip chip--${({ pending: 'amber', writing: 'blue', written_off: 'green', cancel_requested: 'orange', returning: 'blue', returned: 'gray', cancelled: 'gray' })[wstate] || 'gray'}">${writeoff.stateText[wstate] || wstate}</span></p>`
              : writeoff.state.status === 'ok' ? html`<p class="muted">В очередь списания попадает, когда заказ получает статус «Собран». Пока пары в резерве: сайт не продаёт их другим.</p>`
              : html`<p class="muted">Связь со складом не настроена: ${writeoff.state.message || 'проверяется'}. Пока заказ держит пары в резерве, а списывать их нужно в приложении вручную.</p>`}
          </section>
          <section class="card card--pad">
            <h2>Оплата</h2>
            <p>${PAY_METHODS[o.pay_method]?.title || o.pay_method}</p>
            <p class="muted">${PAY_METHODS[o.pay_method]?.hint || ''}</p>
            ${o.comment ? html`<h3 class="sub">Комментарий клиента</h3><p class="quote">${o.comment}</p>` : ''}
          </section>
          <section class="card card--pad">
            <h2>Ссылка для клиента</h2>
            <p class="muted">Клиент видит по ней статус и состав заказа</p>
            <p><a class="link" href="${publicUrl}" target="_blank" rel="noopener">Открыть страницу заказа</a></p>
          </section>
        </aside>
      </div>`;
      await render(req, res, 'orders', {
        title: `Заказ № ${o.number}`, body, wide: true,
        actions: html`<span class="muted">от ${fmt.dateTime(o.created_at)}</span> ${chip(o.status)} <a class="btn btn--ghost btn--sm" href="/admin/orders">${icon('chevron-left')} К списку</a>`,
      });
    } catch (e) { next(e); }
  });

  // ---------- Действия ----------
  const orderId = (req) => { const id = parseInt(req.params.id, 10); return Number.isInteger(id) ? id : 0; };
  const who = (req) => req.admin.user.name;

  router.post('/orders/:id/status', auth.require('orders'), async (req, res, next) => {
    try {
      const id = orderId(req);
      const status = String(req.body.status || '');
      if (!STATUSES[status]) { res.flash('err', 'Неизвестный статус'); return res.redirect(`/admin/orders/${id}`); }
      const note = str(req.body.note, 300);
      const changed = await db.tx(async (c) => {
        const cur = (await c.query('SELECT status FROM webshop.orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!cur || cur.status === status) return null;
        await c.query('UPDATE webshop.orders SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
        await c.query("INSERT INTO webshop.order_events (order_id, admin_name, kind, text) VALUES ($1, $2, 'status', $3)",
          [id, who(req), `Статус: ${STATUSES[cur.status].title} → ${STATUSES[status].title}${note ? '. ' + note : ''}`]);
        return cur.status;
      });
      if (changed) await writeoff.sync().catch(() => {}); // очередь списания в приложении: собран - поставить, отменён - снять
      catalog.invalidate();
      res.flash('ok', changed ? `Статус изменён: ${STATUSES[status].title}` : 'Статус не изменился');
      res.redirect(`/admin/orders/${id}`);
    } catch (e) { next(e); }
  });

  router.post('/orders/:id/note', auth.require('orders'), async (req, res, next) => {
    try {
      const id = orderId(req);
      const note = str(req.body.note, 500);
      if (note) await db.query("INSERT INTO webshop.order_events (order_id, admin_name, kind, text) VALUES ($1, $2, 'note', $3)", [id, who(req), note]);
      res.redirect(`/admin/orders/${id}`);
    } catch (e) { next(e); }
  });

  router.post('/orders/:id/track', auth.require('orders'), async (req, res, next) => {
    try {
      const id = orderId(req);
      const track = str(req.body.track, 60);
      await db.query('UPDATE webshop.orders SET track_number = $2, updated_at = NOW() WHERE id = $1', [id, track]);
      if (track) await db.query("INSERT INTO webshop.order_events (order_id, admin_name, kind, text) VALUES ($1, $2, 'note', $3)", [id, who(req), `Трек-номер: ${track}`]);
      res.flash('ok', 'Трек-номер сохранён');
      res.redirect(`/admin/orders/${id}`);
    } catch (e) { next(e); }
  });
};
