'use strict';
// Настройки магазина: доставка и оплата, сотрудники, контакты, свой пароль.
const { html } = require('../html');
const { str, slugify } = require('../util');
const sec = require('../security');
const { ROLES } = require('./auth');

const KIND = { pickup: 'Самовывоз', courier: 'Курьер', tc: 'Транспортная компания' };
const money = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e7) : 0; };

module.exports = function mount({ db, auth, render, fmt, router, settings, delivery, notifier }) {
  // ---------- Доставка и оплата ----------
  router.get('/delivery', auth.require('delivery'), async (req, res, next) => {
    try {
      delivery.invalidate();
      const d = await delivery.all();
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Способы доставки</h2><p class="muted">Покупатель видит активные способы на странице оформления. Бесплатная доставка включается от указанной суммы заказа. Для транспортных компаний цена - «от»: окончательно её подтверждает менеджер.</p></div></header>
        <div class="mlist">
          ${d.methods.map((m) => html`<form class="mform${m.active ? '' : ' is-hidden'}" method="post" action="/admin/delivery/method/${m.code}">${req.adminCsrf}
            <div class="mform__head"><b>${m.title}</b><span class="chip chip--gray">${KIND[m.kind]}</span><label class="check check--end"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}><span>Включён</span></label></div>
            <div class="mform__grid">
              <label class="field">Название<input name="title" value="${m.title}" maxlength="60" required></label>
              <label class="field">Срок<input name="eta" value="${m.eta}" maxlength="60" placeholder="2-6 дней"></label>
              <label class="field">Стоимость, ₽<input name="price" inputmode="decimal" value="${m.price}"></label>
              <label class="field">${m.kind === 'tc' ? 'Доплата за доставку до двери, ₽' : 'Доплата до двери, ₽'}<input name="door_extra" inputmode="decimal" value="${m.door_extra}"></label>
              <label class="field">Бесплатно от суммы, ₽<input name="free_from" inputmode="decimal" value="${m.free_from ?? ''}" placeholder="не бесплатно"></label>
              <label class="field">Города<input name="cities" value="${m.cities}" maxlength="200" placeholder="пусто - любой город; или: Москва, Санкт-Петербург"></label>
              <label class="field field--wide">Описание<input name="description" value="${m.description}" maxlength="200"></label>
              <label class="field">Порядок<input name="sort" type="number" value="${m.sort}" min="0" max="999"></label>
            </div>
            <div class="mform__foot"><button class="btn btn--primary btn--sm" type="submit">Сохранить</button></div>
          </form>`)}
        </div>
        <form class="inline inline--wrap" method="post" action="/admin/delivery/method">${req.adminCsrf}
          <b>Добавить способ:</b>
          <input name="title" placeholder="Например, Яндекс Доставка" maxlength="60" required>
          <select name="kind" aria-label="Тип"><option value="tc">Транспортная компания</option><option value="courier">Курьер</option><option value="pickup">Самовывоз</option></select>
          <button class="btn btn--sm" type="submit">Добавить</button></form>
      </section>

      <section class="card card--pad">
        <header class="card__h"><div><h2>Пункты самовывоза</h2><p class="muted">Адреса, где покупатель может забрать и примерить заказ</p></div></header>
        <div class="mlist">
          ${d.points.map((p) => html`<form class="mform${p.active ? '' : ' is-hidden'}" method="post" action="/admin/delivery/point/${p.id}">${req.adminCsrf}
            <div class="mform__grid">
              <label class="field">Название<input name="title" value="${p.title}" maxlength="80" required></label>
              <label class="field">Адрес<input name="address" value="${p.address}" maxlength="160" required></label>
              <label class="field">Часы работы<input name="hours" value="${p.hours}" maxlength="80"></label>
              <label class="check check--end"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}><span>Работает</span></label>
            </div>
            <div class="mform__foot"><button class="btn btn--primary btn--sm" type="submit">Сохранить</button></div></form>`)}
        </div>
        <form class="inline inline--wrap" method="post" action="/admin/delivery/point">${req.adminCsrf}
          <b>Добавить пункт:</b><input name="title" placeholder="Название" required maxlength="80"><input name="address" placeholder="Адрес" required maxlength="160">
          <button class="btn btn--sm" type="submit">Добавить</button></form>
      </section>
      <section class="card card--pad"><h2>Оплата</h2>
        <p>Сейчас доступны два способа: <b>онлайн (картой или по СБП)</b> - менеджер присылает ссылку на оплату после подтверждения заказа, и <b>при получении</b> - для самовывоза и курьера. Для транспортных компаний сайт требует предоплату.</p>
        <p class="muted">Автоматическая оплата на сайте (эквайринг) подключается отдельно: нужны договор с банком или платёжным сервисом и ключи доступа.</p></section>`;
      await render(req, res, 'delivery', { title: 'Доставка и оплата', body });
    } catch (e) { next(e); }
  });

  router.post('/delivery/method/:code', auth.require('delivery'), async (req, res, next) => {
    try {
      const b = req.body;
      const free = String(b.free_from || '').trim() === '' ? null : money(b.free_from);
      await db.query(
        `UPDATE webshop.delivery_methods SET title = $2, description = $3, price = $4, door_extra = $5, free_from = $6, eta = $7, cities = $8, active = $9, sort = $10 WHERE code = $1`,
        [req.params.code, str(b.title, 60) || 'Доставка', str(b.description, 200), money(b.price), money(b.door_extra), free, str(b.eta, 60), str(b.cities, 200), b.active === 'on', Math.min(999, Math.max(0, parseInt(b.sort, 10) || 0))]);
      delivery.invalidate();
      res.flash('ok', 'Способ доставки сохранён');
      res.redirect('/admin/delivery');
    } catch (e) { next(e); }
  });
  router.post('/delivery/method', auth.require('delivery'), async (req, res, next) => {
    try {
      const kind = ['pickup', 'courier', 'tc'].includes(req.body.kind) ? req.body.kind : 'tc';
      const title = str(req.body.title, 60);
      let code = slugify(title).replace(/[^a-z0-9-]/g, '') || kind;
      const exists = await db.query('SELECT 1 FROM webshop.delivery_methods WHERE code = $1', [code]);
      if (exists.rowCount) code += '-' + sec.randomId(3).toLowerCase().replace(/[^a-z0-9]/g, 'x');
      const sort = (await db.query('SELECT COALESCE(MAX(sort), 0) + 10 AS n FROM webshop.delivery_methods')).rows[0].n;
      if (title) await db.query('INSERT INTO webshop.delivery_methods (code, kind, title, sort, active) VALUES ($1, $2, $3, $4, FALSE)', [code, kind, title, sort]);
      delivery.invalidate();
      res.flash('ok', 'Способ добавлен, но выключен: заполните стоимость и срок, затем включите');
      res.redirect('/admin/delivery');
    } catch (e) { next(e); }
  });
  router.post('/delivery/point/:id', auth.require('delivery'), async (req, res, next) => {
    try {
      const b = req.body;
      await db.query('UPDATE webshop.pickup_points SET title = $2, address = $3, hours = $4, active = $5 WHERE id = $1',
        [parseInt(req.params.id, 10), str(b.title, 80), str(b.address, 160), str(b.hours, 80), b.active === 'on']);
      delivery.invalidate();
      res.flash('ok', 'Пункт сохранён');
      res.redirect('/admin/delivery');
    } catch (e) { next(e); }
  });
  router.post('/delivery/point', auth.require('delivery'), async (req, res, next) => {
    try {
      if (str(req.body.title, 80) && str(req.body.address, 160)) {
        await db.query('INSERT INTO webshop.pickup_points (title, address, sort) VALUES ($1, $2, (SELECT COALESCE(MAX(sort), 0) + 10 FROM webshop.pickup_points))', [str(req.body.title, 80), str(req.body.address, 160)]);
        delivery.invalidate();
        res.flash('ok', 'Пункт добавлен');
      }
      res.redirect('/admin/delivery');
    } catch (e) { next(e); }
  });

  // ---------- Сотрудники ----------
  router.get('/users', auth.require('users'), async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT id, username, display_name, role, active, created_at, last_login_at FROM webshop.admin_users ORDER BY id');
      const me = req.admin.user.id;
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Роли</h2></div></header>
        <ul class="plainlist">${Object.entries(ROLES).map(([k, r]) => html`<li><span><b>${r.title}</b> <small class="muted">${r.hint}</small></span></li>`)}</ul>
      </section>
      <section class="card card--pad">
        <header class="card__h"><h2>Сотрудники</h2></header>
        <div class="mlist">
          ${rows.map((u) => html`<form class="mform${u.active ? '' : ' is-hidden'}" method="post" action="/admin/users/${u.id}">${req.adminCsrf}
            <div class="mform__head"><b>${u.display_name || u.username}</b><span class="muted">логин: ${u.username}</span>${u.id === me ? html`<span class="chip chip--blue">это вы</span>` : ''}<span class="muted mform__last">${u.last_login_at ? 'вход: ' + fmt.dateTime(u.last_login_at) : 'ещё не входил'}</span></div>
            <div class="mform__grid">
              <label class="field">Имя<input name="display_name" value="${u.display_name}" maxlength="60"></label>
              <label class="field">Роль<select name="role">${Object.entries(ROLES).map(([k, r]) => html`<option value="${k}" ${u.role === k ? 'selected' : ''}>${r.title}</option>`)}</select></label>
              <label class="field">Новый пароль<input name="password" type="password" autocomplete="new-password" placeholder="оставьте пустым, чтобы не менять"></label>
              <label class="check check--end"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>Может входить</span></label>
            </div>
            <div class="mform__foot"><button class="btn btn--primary btn--sm" type="submit">Сохранить</button></div></form>`)}
        </div>
      </section>
      <section class="card card--pad">
        <header class="card__h"><h2>Новый сотрудник</h2></header>
        <form method="post" action="/admin/users" class="mform__grid mform__grid--create">${req.adminCsrf}
          <label class="field">Логин<input name="username" required maxlength="40" autocomplete="off" placeholder="latin, цифры, точка"></label>
          <label class="field">Имя<input name="display_name" maxlength="60" placeholder="Как показывать в админке"></label>
          <label class="field">Роль<select name="role">${Object.entries(ROLES).map(([k, r]) => html`<option value="${k}" ${k === 'manager' ? 'selected' : ''}>${r.title}</option>`)}</select></label>
          <label class="field">Пароль (от 8 знаков)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <div class="mform__foot"><button class="btn btn--primary" type="submit">Создать</button></div>
        </form>
      </section>`;
      await render(req, res, 'users', { title: 'Сотрудники', body });
    } catch (e) { next(e); }
  });

  router.post('/users', auth.require('users'), async (req, res, next) => {
    try {
      const username = str(req.body.username, 40).toLowerCase();
      const pwErr = sec.validateNewPassword(String(req.body.password || ''));
      const role = ROLES[req.body.role] ? req.body.role : 'manager';
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) res.flash('err', 'Логин: 3-40 знаков, латиница, цифры, точка, дефис, подчёркивание');
      else if (pwErr) res.flash('err', pwErr);
      else {
        const r = await db.query('INSERT INTO webshop.admin_users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [username, str(req.body.display_name, 60), sec.hashPassword(String(req.body.password)), role]);
        res.flash(r.rowCount ? 'ok' : 'err', r.rowCount ? `Сотрудник ${username} создан` : 'Такой логин уже есть');
      }
      res.redirect('/admin/users');
    } catch (e) { next(e); }
  });

  router.post('/users/:id', auth.require('users'), async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const role = ROLES[req.body.role] ? req.body.role : 'manager';
      const active = req.body.active === 'on';
      const pw = String(req.body.password || '');
      if (pw && sec.validateNewPassword(pw)) { res.flash('err', sec.validateNewPassword(pw)); return res.redirect('/admin/users'); }
      const ok = await db.tx(async (c) => {
        // Нельзя остаться без владельца
        const owners = (await c.query("SELECT id FROM webshop.admin_users WHERE role = 'owner' AND active AND id <> $1", [id])).rows.length;
        if (!owners && (role !== 'owner' || !active)) return false;
        await c.query('UPDATE webshop.admin_users SET display_name = $2, role = $3, active = $4 WHERE id = $1', [id, str(req.body.display_name, 60), role, active]);
        if (pw) await c.query('UPDATE webshop.admin_users SET password_hash = $2 WHERE id = $1', [id, sec.hashPassword(pw)]);
        return true;
      });
      res.flash(ok ? 'ok' : 'err', ok ? 'Сохранено' : 'В админке должен остаться хотя бы один активный владелец');
      res.redirect('/admin/users');
    } catch (e) { next(e); }
  });

  // ---------- Уведомления о заказах ----------
  async function notifyCard(req) {
    const st = await notifier.status();
    const when = (d) => (d ? fmt.dateTime(d) : 'ещё не было');
    return html`<section class="card card--pad"><h2>Уведомления о новых заказах</h2>
      ${st.enabled
        ? html`<p><span class="chip chip--green">Telegram подключён</span> чатов: <b>${st.chats}</b>. Последнее отправлено: ${when(st.last_sent)}.
            ${st.waiting ? html`В очереди: <b>${st.waiting}</b>.` : ''}</p>
          ${st.failed ? html`<p><span class="chip chip--red">Не доставлено</span> после всех попыток: <b>${st.failed}</b>${st.last_error ? html` (${st.last_error})` : ''}. Проверьте токен бота и чат: бот должен быть добавлен в чат и иметь право писать.</p>` : ''}
          ${!st.failed && st.waiting && st.last_error ? html`<p class="muted">Последняя ошибка: ${st.last_error}. Отправка повторится сама.</p>` : ''}
          <form method="post" action="/admin/notify/test">${req.adminCsrf}<button class="btn" type="submit">Отправить тестовое сообщение</button></form>`
        : html`<p><span class="chip chip--gray">Не настроены</span> Новые заказы можно получать в Telegram: создайте бота у <b>@BotFather</b>, добавьте его в нужный чат и впишите на сервере в файл <code>.env</code> строки
            <code>TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_CHAT_ID</code> (несколько чатов через запятую), затем перезапустите магазин. Подробности в README.</p>`}
    </section>`;
  }
  router.post('/notify/test', auth.require('settings'), async (req, res, next) => {
    try {
      if (!notifier.enabled()) res.flash('err', 'Telegram не настроен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env');
      else {
        const r = await notifier.test();
        const bad = r.filter((x) => !x.ok);
        res.flash(bad.length ? 'err' : 'ok', bad.length ? `Не отправлено: ${bad.map((x) => `${x.chat}: ${x.error}`).join('; ')}` : `Тестовое сообщение отправлено (чатов: ${r.length})`);
      }
      res.redirect('/admin/settings');
    } catch (e) { next(e); }
  });

  // ---------- Настройки магазина ----------
  router.get('/settings', auth.require('settings'), async (req, res, next) => {
    try {
      const s = await settings.get();
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Магазин и контакты</h2><p class="muted">Показываются в шапке, подвале и на странице доставки</p></div></header>
        <form method="post" action="/admin/settings" class="mform__grid">${req.adminCsrf}
          <label class="field">Название магазина<input name="shopName" value="${s.shopName}" maxlength="40" required></label>
          <label class="field">Телефон<input name="phone" value="${s.phone}" maxlength="40"></label>
          <label class="field">Почта<input name="email" type="email" value="${s.email}" maxlength="80"></label>
          <label class="field">Часы работы<input name="hours" value="${s.hours}" maxlength="80"></label>
          <label class="field field--wide">Адрес магазина<input name="address" value="${s.address}" maxlength="160"></label>
          <div class="mform__foot"><button class="btn btn--primary" type="submit">Сохранить</button></div>
        </form>
      </section>
      <section class="card card--pad"><h2>Откуда берутся товары</h2>
        <p>Модели, цены, фото и остатки сайт читает из общей базы приложения «Склад» (только чтение) и обновляет раз в полминуты. Размеры одной модели склеиваются по артикулу: <code>DD1391-100_42</code> - модель <code>DD1391-100</code>, размер 42. Заказы с сайта держат товар в резерве, пока их не отправили: после отправки списывайте его в приложении.</p>
        <p class="muted">Цены меняются в приложении. Здесь они не правятся.</p></section>
      ${await notifyCard(req)}`;
      await render(req, res, 'settings', { title: 'Настройки', body });
    } catch (e) { next(e); }
  });
  router.post('/settings', auth.require('settings'), async (req, res, next) => {
    try {
      const b = req.body;
      await settings.set({ shopName: str(b.shopName, 40) || 'Магазин', phone: str(b.phone, 40), email: str(b.email, 80), hours: str(b.hours, 80), address: str(b.address, 160) });
      res.flash('ok', 'Настройки сохранены');
      res.redirect('/admin/settings');
    } catch (e) { next(e); }
  });

  // ---------- Свой пароль ----------
  router.get('/account', auth.require('account'), async (req, res, next) => {
    try {
      const u = req.admin.user;
      const body = html`
      <section class="card card--pad narrow">
        <h2>${u.name}</h2><p class="muted">Логин: ${u.username} · ${ROLES[u.role].title}</p>
        <form method="post" action="/admin/account" class="form">${req.adminCsrf}
          <label class="field">Текущий пароль<input name="current" type="password" autocomplete="current-password" required></label>
          <label class="field">Новый пароль (от 8 знаков)<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
          <button class="btn btn--primary" type="submit">Сменить пароль</button>
        </form>
        <p class="muted">После смены пароля вход на других устройствах закроется.</p>
      </section>`;
      await render(req, res, 'account', { title: 'Мой аккаунт', body });
    } catch (e) { next(e); }
  });
  router.post('/account', auth.require('account'), async (req, res, next) => {
    try {
      const u = (await db.query('SELECT id, password_hash FROM webshop.admin_users WHERE id = $1', [req.admin.user.id])).rows[0];
      const err = sec.validateNewPassword(String(req.body.password || ''));
      if (!sec.verifyPassword(String(req.body.current || ''), u.password_hash)) res.flash('err', 'Текущий пароль неверный');
      else if (err) res.flash('err', err);
      else {
        const hash = sec.hashPassword(String(req.body.password));
        await db.query('UPDATE webshop.admin_users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
        auth.startSession(res, { id: u.id, password_hash: hash });
        res.flash('ok', 'Пароль изменён');
      }
      res.redirect('/admin/account');
    } catch (e) { next(e); }
  });
};
