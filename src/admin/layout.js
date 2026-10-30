'use strict';
// Оболочка страниц админки: боковое меню по ролям, заголовок страницы, сообщения.
const { html } = require('../html');
const { icon, sprite } = require('../icons');
const { ROLES, can } = require('./auth');
const { sparkline } = require('./charts');

const NAV = [
  { key: 'dashboard', href: '/admin', icon: 'dashboard', title: 'Сводка' },
  { key: 'orders', href: '/admin/orders', icon: 'orders', title: 'Заказы', badge: 'fresh' },
  { key: 'customers', href: '/admin/customers', icon: 'users', title: 'Клиенты' },
  { key: 'traffic', href: '/admin/traffic', icon: 'chart', title: 'Посещаемость' },
  { key: 'showcase', href: '/admin/showcase', icon: 'palette', title: 'Витрина и каталог' },
  { key: 'delivery', href: '/admin/delivery', icon: 'truck', title: 'Доставка и оплата' },
  { key: 'users', href: '/admin/users', icon: 'user', title: 'Сотрудники' },
  { key: 'settings', href: '/admin/settings', icon: 'settings', title: 'Настройки' },
];

function adminPage(req, { title, section, actions = '', body, wide = false }) {
  const a = req.admin;
  const shop = req.shopName || 'Магазин';
  return html`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title} - Админка</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/css/admin.css?v=${req.assetV}">
</head>
<body>
  ${sprite()}
  <div class="shell">
    <aside class="side" id="side">
      <a class="side__brand" href="/admin"><svg class="logo__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 21c0-2 1-3 3-3.4l4.6-.9c1.6-.3 2.7-1.3 3.4-2.8l1-2.1 4.2 2.2c1.6.8 3.2 1.4 4.8 1.8 2.5.6 4 1.6 4 3.7V24H3v-3Z"/><path class="logo__sole" d="M3 26h26"/></svg><span>${shop}<small>админка</small></span></a>
      <nav class="side__nav">
        ${NAV.filter((n) => can(a.user.role, n.key)).map((n) => html`<a class="side__link${section === n.key ? ' is-active' : ''}" href="${n.href}">${icon(n.icon)}<span>${n.title}</span>${n.badge && req.badges && req.badges[n.badge] ? html`<b class="side__badge">${req.badges[n.badge]}</b>` : ''}</a>`)}
      </nav>
      <div class="side__foot">
        <a class="side__link" href="/" target="_blank" rel="noopener">${icon('eye')}<span>Открыть сайт</span></a>
        <div class="side__user">
          <span class="avatar">${(a.user.name || '?').slice(0, 1).toUpperCase()}</span>
          <a href="/admin/account" class="side__who"><b>${a.user.name}</b><small>${ROLES[a.user.role].title}</small></a>
          <form action="/admin/logout" method="post">${req.adminCsrf}<button class="iconbtn" title="Выйти" aria-label="Выйти">${icon('logout')}</button></form>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <button class="iconbtn top__menu" type="button" data-side-toggle aria-label="Меню">${icon('sliders')}</button>
        <h1>${title}</h1>
        <div class="top__actions">${actions}</div>
      </header>
      ${a.flash ? html`<div class="flash flash--${a.flash.kind}" role="status">${a.flash.text}</div>` : ''}
      <div class="content${wide ? ' content--wide' : ''}">${body}</div>
    </div>
  </div>
  <div class="tip" id="tip" role="tooltip" hidden></div>
  <script src="/static/js/admin.js?v=${req.assetV}" defer></script>
</body>
</html>`;
}

// Выбор периода: пресеты строкой над содержимым
function rangePicker(base, current, ranges, extra = '') {
  return html`<nav class="range" aria-label="Период">${Object.entries(ranges).map(([k, t]) => html`<a class="${String(current) === k ? 'is-active' : ''}" href="${base}?range=${k}${extra}">${t}</a>`)}</nav>`;
}

// Плитка показателя: подпись, значение, изменение к прошлому периоду (цвет = направление × хорошо ли это), мини-график
function stat({ label, value, delta = null, goodWhenUp = true, trend = null, hero = false, note = '', href = '' }) {
  let d = '';
  if (delta !== null && Number.isFinite(delta)) {
    const up = delta > 0.5;
    const down = delta < -0.5;
    const tone = !up && !down ? 'flat' : (up === goodWhenUp ? 'good' : 'bad');
    d = html`<span class="delta delta--${tone}">${up ? '▲' : down ? '▼' : '•'} ${Math.abs(Math.round(delta))}%<small>${hero ? ' к прошлому периоду' : ' к прошлому'}</small></span>`;
  } else if (note) d = html`<span class="delta delta--flat"><small>${note}</small></span>`;
  const inner = html`<p class="stat__l">${label}</p><p class="stat__v${hero ? ' stat__v--hero' : ''}">${value}</p>${d}${trend ? html`<div class="stat__trend">${sparkline(trend)}</div>` : ''}`;
  return href ? html`<a class="stat${hero ? ' stat--hero' : ''}" href="${href}">${inner}</a>` : html`<div class="stat${hero ? ' stat--hero' : ''}">${inner}</div>`;
}

// Постраничная навигация для таблиц: base уже содержит параметры фильтра
function pager(base, page, pages) {
  if (pages <= 1) return '';
  const link = (p) => `${base}${base.includes('?') ? '&' : '?'}page=${p}`;
  const nums = [...new Set([1, 2, page - 1, page, page + 1, pages - 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of nums) {
    if (p - prev > 1) out.push(html`<span class="pager__gap">…</span>`);
    out.push(p === page ? html`<span class="is-current">${p}</span>` : html`<a href="${link(p)}">${p}</a>`);
    prev = p;
  }
  return html`<nav class="pager" aria-label="Страницы">${page > 1 ? html`<a href="${link(page - 1)}" aria-label="Назад">${icon('chevron-left')}</a>` : ''}${out}${page < pages ? html`<a href="${link(page + 1)}" aria-label="Вперёд">${icon('chevron-right')}</a>` : ''}</nav>`;
}

const pctChange = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : cur > 0 ? 100 : null);

module.exports = { adminPage, rangePicker, stat, pctChange, pager, NAV };
