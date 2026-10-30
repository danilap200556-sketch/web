'use strict';
const express = require('express');
const { html } = require('../html');
const { rub, num, plural, dateFmt } = require('../util');
const { createAuth, can, homeFor, ROLES } = require('./auth');
const { adminPage, rangePicker, stat, pctChange } = require('./layout');
const charts = require('./charts');
const stats = require('./stats');
const { STATUSES } = require('../orders');
const { photoUrl } = require('../shopviews');

const ASSET_V = Date.now().toString(36);

const chip = (status) => html`<span class="chip chip--${STATUSES[status]?.tone || 'gray'}">${STATUSES[status]?.title || status}</span>`;

module.exports = function mount(app, services) {
  const { cfg, db, catalog, settings } = services;
  const auth = createAuth(services);
  const fmt = dateFmt(cfg.tz);
  const router = express.Router();
  router.use(auth.attach);

  // Единая отрисовка страницы: подставляет csrf, счётчик новых заказов и название магазина
  async function render(req, res, section, opts, status = 200) {
    req.shopName = (await settings.get()).shopName;
    req.assetV = ASSET_V;
    req.adminCsrf = auth.csrfField(req);
    if (can(req.admin.user.role, 'orders')) {
      const r = await db.query("SELECT COUNT(*)::int AS n FROM webshop.orders WHERE status = 'new'");
      req.badges = { fresh: r.rows[0].n };
    }
    res.status(status).type('html').send(adminPage(req, { section, ...opts }).toString());
  }
  const ctx = { ...services, auth, render, fmt, chip, router, app };
  app.locals.adminForbidden = (req) => adminPage(Object.assign(req, { shopName: 'Магазин', assetV: ASSET_V, adminCsrf: '' }), {
    title: 'Нет доступа', section: '',
    body: html`<div class="card card--pad"><h2>Нет доступа</h2><p>У вашей роли (${ROLES[req.admin.user.role].title}) нет доступа к этому разделу.</p><p><a class="btn" href="${homeFor(req.admin.user.role)}">Вернуться</a></p></div>`,
  }).toString();

  // ---------- Вход / выход ----------
  const loginPage = ({ error = '', username = '', next = '' } = {}) => html`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Вход - Админка</title><link rel="icon" href="/static/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/static/css/admin.css?v=${ASSET_V}"></head>
<body class="login">
  <main class="login__card">
    <svg class="logo__mark login__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 21c0-2 1-3 3-3.4l4.6-.9c1.6-.3 2.7-1.3 3.4-2.8l1-2.1 4.2 2.2c1.6.8 3.2 1.4 4.8 1.8 2.5.6 4 1.6 4 3.7V24H3v-3Z"/><path class="logo__sole" d="M3 26h26"/></svg>
    <h1>Вход в админку</h1>
    <p class="muted">Заказы, клиенты, витрина и статистика магазина</p>
    ${error ? html`<div class="flash flash--err" role="alert">${error}</div>` : ''}
    <form method="post" action="/admin/login" class="form">
      <input type="hidden" name="next" value="${next}">
      <label class="field">Логин<input name="username" value="${username}" autocomplete="username" autofocus required></label>
      <label class="field">Пароль<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn--primary btn--block" type="submit">Войти</button>
    </form>
  </main>
</body></html>`;

  router.get('/login', (req, res) => {
    if (req.admin.user) return res.redirect(homeFor(req.admin.user.role));
    res.type('html').send(loginPage({ next: String(req.query.next || '') }).toString());
  });
  router.post('/login', async (req, res, next) => {
    try {
      const username = String(req.body.username || '').slice(0, 60);
      const r = await auth.login(req, username, String(req.body.password || '').slice(0, 200));
      if (r.error) return res.status(401).type('html').send(loginPage({ error: r.error, username, next: String(req.body.next || '') }).toString());
      auth.startSession(res, r.user);
      const nx = String(req.body.next || '');
      res.redirect(nx.startsWith('/admin') && !nx.startsWith('//') ? nx : '/admin');
    } catch (e) { next(e); }
  });
  router.post('/logout', auth.require(), (req, res) => { res.clearCookie(auth.cookieName, auth.opts()); res.redirect('/admin/login'); });

  const funnelOf = (f) => charts.funnel([
    { label: 'Зашли на сайт', value: f.visits }, { label: 'Открыли модель', value: f.viewed }, { label: 'Положили в корзину', value: f.carted },
    { label: 'Начали оформление', value: f.checkout }, { label: 'Оформили заказ', value: f.ordered },
  ]);

  // ---------- Сводка ----------
  router.get('/', auth.require(), (req, res, next) => {
    if (!can(req.admin.user.role, 'dashboard')) return res.redirect(homeFor(req.admin.user.role));
    next();
  }, async (req, res, next) => {
    try {
      await catalog.ensure();
      const days = stats.parseRange(req.query.range);
      const b = await stats.bounds(db, cfg.tz, days);
      const [cur, prev, daily, funnel, sources, devices, statuses, deliveries, cities, sold, recent, attn] = await Promise.all([
        stats.kpis(db, b.lo, b.hi), stats.kpis(db, b.plo, b.lo), stats.daily(db, cfg.tz, b), stats.funnel(db, b), stats.sources(db, b),
        stats.devices(db, b), stats.statuses(db, b), stats.deliveries(db, b), stats.cities(db, b), stats.topSold(db, b, 6), stats.recentOrders(db, 7), stats.attention(db),
      ]);
      // 12 точек для мини-графика: период делится на равные части
      const spark = (key, n = 12) => {
        const size = Math.max(1, Math.floor(daily.length / n));
        const out = [];
        for (let i = 0; i < daily.length; i += size) out.push(daily.slice(i, i + size).reduce((a, d) => a + d[key], 0));
        return out.slice(-n);
      };
      const label = days === 1 ? 'сегодня' : `за ${days} ${plural(days, 'день', 'дня', 'дней')}`;
      const stOrder = ['new', 'confirmed', 'paid', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];
      const stMap = new Map(statuses.map((s) => [s.status, s]));
      const body = html`
      ${rangePicker('/admin', days, stats.RANGES)}
      ${attn.fresh || attn.to_pack || attn.to_ship ? html`<div class="attn">
        <a href="/admin/orders?status=new" class="attn__i${attn.stale ? ' is-hot' : ''}"><b>${attn.fresh}</b><span>${plural(attn.fresh, 'новый заказ', 'новых заказа', 'новых заказов')}${attn.stale ? html`, ${attn.stale} ждут больше 2 часов` : ''}</span></a>
        <a href="/admin/orders?status=confirmed" class="attn__i"><b>${attn.to_pack}</b><span>подтверждены, ждут оплаты и сборки</span></a>
        <a href="/admin/orders?status=packed" class="attn__i"><b>${attn.to_ship}</b><span>собраны, готовы к отправке</span></a>
      </div>` : ''}
      <div class="stats stats--dash">
        ${stat({ label: `Выручка ${label}`, value: rub(cur.revenue), delta: pctChange(cur.revenue, prev.revenue), trend: spark('revenue'), hero: true })}
        ${stat({ label: 'Заказов', value: num(cur.orders), delta: pctChange(cur.orders, prev.orders), trend: spark('orders'), href: '/admin/orders' })}
        ${stat({ label: 'Средний чек', value: rub(cur.avg), delta: pctChange(cur.avg, prev.avg) })}
        ${stat({ label: 'Визитов на сайт', value: num(cur.visits), delta: pctChange(cur.visits, prev.visits), trend: spark('visits'), href: '/admin/traffic' })}
        ${stat({ label: 'Конверсия в заказ', value: cur.conversion.toFixed(1).replace('.', ',') + '%', delta: pctChange(cur.conversion, prev.conversion) })}
        ${stat({ label: 'Новых клиентов', value: num(cur.newCustomers), delta: pctChange(cur.newCustomers, prev.newCustomers), href: '/admin/customers' })}
        ${stat({ label: 'Отмены и возвраты', value: num(cur.cancelled), delta: pctChange(cur.cancelled, prev.cancelled), goodWhenUp: false, note: 'заказов не дошли до клиента' })}
      </div>
      <div class="grid2">
        <section class="card"><header class="card__h"><div><h2>Выручка по дням, ₽</h2><p class="muted">без отменённых и возвращённых заказов</p></div></header>
          ${charts.barChart({ labels: daily.map((d) => d.day), values: daily.map((d) => d.revenue), name: 'Выручка', fmt: rub, title: 'Выручка по дням' })}
          ${charts.tableView({ head: ['День', 'Выручка', 'Заказов'], rows: daily.map((d) => [charts.dayLabel(d.day), rub(d.revenue), num(d.orders)]) })}
        </section>
        <section class="card"><header class="card__h"><div><h2>Заказы по статусам</h2><p class="muted">${num(cur.orders)} ${plural(cur.orders, 'заказ', 'заказа', 'заказов')} ${label}</p></div></header>
          ${cur.orders ? charts.hBars({ items: stOrder.filter((s) => stMap.has(s)).map((s) => ({ label: STATUSES[s].title, value: stMap.get(s).n })), sub: 'Заказов' }) : html`<p class="muted">Заказов за этот период нет</p>`}
          ${cur.cancelled ? html`<p class="muted note">Отмены и возвраты: ${cur.cancelled} ${plural(cur.cancelled, 'заказ', 'заказа', 'заказов')}</p>` : ''}
        </section>
      </div>
      <div class="grid2">
        <section class="card"><header class="card__h"><div><h2>Посещения по дням</h2><p class="muted">визит - заход на сайт, посетитель - человек (по cookie). Пунктир - сегодня, день ещё не закончился</p></div></header>
          ${charts.lineChart({ labels: daily.map((d) => d.day), series: [{ name: 'Визиты', values: daily.map((d) => d.visits), cls: 's1' }, { name: 'Посетители', values: daily.map((d) => d.uniques), cls: 's2' }], title: 'Посещения по дням', partialLast: days > 1 })}
          ${charts.tableView({ head: ['День', 'Визиты', 'Посетители', 'Просмотры страниц'], rows: daily.map((d) => [charts.dayLabel(d.day), num(d.visits), num(d.uniques), num(d.views)]) })}
        </section>
        <section class="card"><header class="card__h"><div><h2>Путь покупателя</h2><p class="muted">сколько визитов дошло до каждого шага</p></div></header>
          ${funnelOf(funnel)}
        </section>
      </div>
      <div class="grid2 grid2--even">
        <section class="card"><header class="card__h"><div><h2>Что покупают</h2><p class="muted">по выручке ${label}</p></div><a class="link" href="/admin/traffic">Просмотры моделей</a></header>
          ${sold.length ? html`<ul class="toplist">${sold.map((s) => html`<li>${s.photo ? html`<img src="${photoUrl(s.photo, 360)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="toplist__ph"></span>`}<div><b>${s.title}</b><small>${s.qty} ${plural(s.qty, 'пара', 'пары', 'пар')}</small></div><span>${rub(s.sum)}</span></li>`)}</ul>` : html`<p class="muted">Продаж за этот период нет</p>`}
        </section>
        <section class="card"><header class="card__h"><div><h2>Последние заказы</h2></div><a class="link" href="/admin/orders">Все заказы</a></header>
          ${recent.length ? html`<div class="tablewrap"><table class="table"><thead><tr><th>№</th><th>Клиент</th><th class="num">Сумма</th><th>Статус</th></tr></thead><tbody>
            ${recent.map((o) => html`<tr><td><a href="/admin/orders/${o.id}"><b>${o.number}</b></a> <small class="muted">${fmt.short(o.created_at)}</small></td><td>${o.name}</td><td class="num">${rub(o.total)}</td><td>${chip(o.status)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Пока нет заказов</p>`}
        </section>
      </div>
      <div class="grid4">
        <section class="card"><header class="card__h"><h2>Откуда приходят</h2></header>${sources.length ? charts.hBars({ items: sources.map((s) => ({ label: s.title, value: s.n })), sub: 'Визитов' }) : html`<p class="muted">Нет данных</p>`}</section>
        <section class="card"><header class="card__h"><h2>С каких устройств</h2></header>${charts.segBar({ parts: devices.map((d, i) => ({ label: d.title, value: d.n, cls: `s${i + 1}` })) })}</section>
        <section class="card"><header class="card__h"><h2>Способы доставки</h2></header>${deliveries.length ? charts.hBars({ items: deliveries.map((d) => ({ label: d.title, value: d.n })), sub: 'Заказов' }) : html`<p class="muted">Нет данных</p>`}</section>
        <section class="card"><header class="card__h"><h2>Города</h2></header>${cities.length ? charts.hBars({ items: cities.map((c) => ({ label: c.city, value: c.n })), sub: 'Заказов' }) : html`<p class="muted">Нет данных</p>`}</section>
      </div>`;
      await render(req, res, 'dashboard', { title: 'Сводка', body, wide: true });
    } catch (e) { next(e); }
  });

  // ---------- Посещаемость ----------
  router.get('/traffic', auth.require('traffic'), async (req, res, next) => {
    try {
      await catalog.ensure();
      const days = stats.parseRange(req.query.range);
      const b = await stats.bounds(db, cfg.tz, days);
      const [cur, prev, daily, funnel, sources, devices, models, pages, hosts] = await Promise.all([
        stats.kpis(db, b.lo, b.hi), stats.kpis(db, b.plo, b.lo), stats.daily(db, cfg.tz, b), stats.funnel(db, b), stats.sources(db, b),
        stats.devices(db, b), stats.topModels(db, b, 10), stats.pages(db, b), stats.refHosts(db, b),
      ]);
      const PAGE_TITLES = { '/': 'Главная', '/catalog': 'Каталог и поиск', '/cart': 'Корзина', '/checkout': 'Оформление', '/delivery': 'Доставка и оплата' };
      const body = html`
      ${rangePicker('/admin/traffic', days, stats.RANGES)}
      <div class="stats stats--4">
        ${stat({ label: 'Визитов', value: num(cur.visits), delta: pctChange(cur.visits, prev.visits) })}
        ${stat({ label: 'Посетителей', value: num(cur.uniques), delta: pctChange(cur.uniques, prev.uniques) })}
        ${stat({ label: 'Просмотров страниц', value: num(cur.views), delta: pctChange(cur.views, prev.views) })}
        ${stat({ label: 'Страниц за визит', value: cur.visits ? (cur.views / cur.visits).toFixed(1).replace('.', ',') : '0', note: 'чем больше, тем глубже смотрят' })}
      </div>
      <section class="card"><header class="card__h"><div><h2>Визиты и посетители по дням</h2><p class="muted">наведите на график, чтобы увидеть числа за день. Пунктир - сегодня, день ещё не закончился</p></div></header>
        ${charts.lineChart({ labels: daily.map((d) => d.day), series: [{ name: 'Визиты', values: daily.map((d) => d.visits), cls: 's1' }, { name: 'Посетители', values: daily.map((d) => d.uniques), cls: 's2' }], title: 'Визиты и посетители по дням', partialLast: days > 1 })}
        ${charts.tableView({ head: ['День', 'Визиты', 'Посетители', 'Просмотры страниц'], rows: daily.map((d) => [charts.dayLabel(d.day), num(d.visits), num(d.uniques), num(d.views)]) })}
      </section>
      <div class="grid2">
        <section class="card"><header class="card__h"><h2>Источники визитов</h2></header>${sources.length ? charts.hBars({ items: sources.map((s) => ({ label: s.title, value: s.n })), sub: 'Визитов' }) : html`<p class="muted">Нет данных</p>`}
          ${hosts.length ? html`<h3 class="sub">Сайты, с которых переходили</h3><ul class="plainlist">${hosts.map((h) => html`<li><span>${h.host}</span><b>${h.n}</b></li>`)}</ul>` : ''}</section>
        <section class="card"><header class="card__h"><h2>Путь покупателя</h2></header>
          ${funnelOf(funnel)}
          <h3 class="sub">Устройства</h3>${charts.segBar({ parts: devices.map((d, i) => ({ label: d.title, value: d.n, cls: `s${i + 1}` })) })}</section>
      </div>
      <div class="grid2">
        <section class="card"><header class="card__h"><div><h2>Самые просматриваемые модели</h2><p class="muted">просмотр → корзина → покупка</p></div></header>
          ${models.length ? html`<div class="tablewrap"><table class="table"><thead><tr><th>Модель</th><th class="num">Просм.</th><th class="num">В корзину</th><th class="num">Продано</th></tr></thead><tbody>
            ${models.map((m) => { const mm = catalog.byKey && catalog.byKey.get(m.key); return html`<tr><td>${mm ? html`<a href="/p/${mm.slug}" target="_blank" rel="noopener">${mm.title}${mm.colorway ? ' «' + mm.colorway + '»' : ''}</a>` : m.key}</td><td class="num">${m.views}</td><td class="num">${m.carts}</td><td class="num">${m.qty}</td></tr>`; })}</tbody></table></div>` : html`<p class="muted">Просмотров моделей за период нет</p>`}</section>
        <section class="card"><header class="card__h"><h2>Страницы</h2></header>
          ${pages.length ? charts.hBars({ items: pages.map((p) => ({ label: PAGE_TITLES[p.path] || p.path, value: p.n })), sub: 'Просмотров' }) : html`<p class="muted">Нет данных</p>`}</section>
      </div>`;
      await render(req, res, 'traffic', { title: 'Посещаемость', body, wide: true });
    } catch (e) { next(e); }
  });

  // Остальные разделы
  require('./orders')(ctx);
  require('./customers')(ctx);
  require('./showcase')(ctx);
  require('./manage')(ctx);

  app.use('/admin', router);
  // Подпись админ-сессии видна витрине: администратор может смотреть другие сезоны (?preview_season=)
  app.locals.adminPeek = auth.peek;
};
