'use strict';
// Общие блоки витрины: оболочка страницы, карточка товара, цена, постраничная навигация.
const { html, esc, raw } = require('./html');
const { icon, sprite } = require('./icons');
const { rub, plural } = require('./util');
const { DEPARTMENTS } = require('./model');
const { SEASONS } = require('./seasons');

const SEASON_ICON = { winter: 'snow', spring: 'flower', summer: 'sun', autumn: 'leaf' };

const photoUrl = (id, w = 640) => `/media/p/${id}/${w}.jpg`;

// Диапазон размеров в наличии: "38-44" или "38 · 40 · 44"
function sizeRange(m) {
  const sizes = m.sizes.filter((s) => s.qty > 0 && s.size);
  if (!sizes.length) return '';
  const uniq = [...new Set(sizes.map((s) => s.size))];
  if (uniq.length <= 3) return uniq.join(' · ');
  return `${uniq[0]}–${uniq[uniq.length - 1]}`;
}

// Цена в карточке: при скидке - новая цена и зачёркнутая старая
function priceBlock(m, cls = '') {
  if (m.oldPrice) return html`<span class="price price--sale ${cls}">${rub(m.price)}</span><s class="price-old">${rub(m.oldPrice)}</s>`;
  return html`<span class="price ${cls}">${m.priceMax > m.price ? 'от ' : ''}${rub(m.price)}</span>`;
}

function badgeOf(m) {
  if (m.badge) return { text: m.badge, kind: 'accent' };
  if (!m.inStock) return { text: 'Нет в наличии', kind: 'muted' };
  if (m.discount) return { text: `−${m.discount}%`, kind: 'sale' };
  if (Date.now() - m.createdAt < 21 * 86400_000) return { text: 'Новинка', kind: 'dark' };
  const sizesLeft = m.sizes.filter((s) => s.qty > 0).length;
  if (m.qty <= 3 && sizesLeft <= 2) return { text: 'Последние размеры', kind: 'warn' };
  return null;
}

function card(m, { priority = false } = {}) {
  const b = badgeOf(m);
  const second = m.photos[1];
  const sizes = sizeRange(m);
  return html`<a class="card${m.inStock ? '' : ' is-out'}" href="/p/${m.slug}" data-model="${m.key}">
    <div class="card__media">
      ${m.cover ? html`<img class="card__img" src="${photoUrl(m.cover, 640)}" srcset="${photoUrl(m.cover, 360)} 360w, ${photoUrl(m.cover, 640)} 640w"
        sizes="(max-width: 720px) 46vw, (max-width: 1100px) 30vw, 300px" alt="${m.title}" width="640" height="640"
        ${priority ? raw('fetchpriority="high"') : raw('loading="lazy" decoding="async"')}>` : ''}
      ${second ? html`<img class="card__img card__img--alt" src="${photoUrl(second, 640)}" alt="" width="640" height="640" loading="lazy" decoding="async">` : ''}
      ${b ? html`<span class="badge badge--${b.kind}">${b.text}</span>` : ''}
    </div>
    <div class="card__body">
      <div class="card__meta">${[m.brand, m.type].filter(Boolean).join(' · ')}</div>
      <h3 class="card__title">${m.model || m.title}</h3>
      ${m.colorway ? html`<div class="card__color">${m.colorway}</div>` : ''}
      <div class="card__foot">
        <span class="card__price">${priceBlock(m)}</span>
        ${sizes ? html`<span class="card__sizes">${sizes}</span>` : ''}
      </div>
    </div>
  </a>`;
}

function pagination(base, page, pages) {
  if (pages <= 1) return '';
  const link = (p) => `${base}${base.includes('?') ? '&' : '?'}page=${p}`;
  const nums = [];
  const add = (p) => { if (!nums.includes(p) && p >= 1 && p <= pages) nums.push(p); };
  add(1); add(2); for (let p = page - 1; p <= page + 1; p++) add(p); add(pages - 1); add(pages);
  nums.sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of nums) {
    if (p - prev > 1) out.push(html`<span class="pager__gap">…</span>`);
    out.push(p === page ? html`<span class="pager__n is-current" aria-current="page">${p}</span>` : html`<a class="pager__n" href="${link(p)}">${p}</a>`);
    prev = p;
  }
  return html`<nav class="pager" aria-label="Страницы">
    ${page > 1 ? html`<a class="pager__arrow" href="${link(page - 1)}" rel="prev">${icon('chevron-left')}</a>` : ''}
    ${out}
    ${page < pages ? html`<a class="pager__arrow" href="${link(page + 1)}" rel="next">${icon('chevron-right')}</a>` : ''}
  </nav>`;
}

function navDepts(ctx) {
  const out = [];
  for (const d of Object.values(DEPARTMENTS)) {
    const has = ctx.deptCounts[d.slug] > 0;
    if (has) out.push(html`<a class="nav__link${ctx.dept === d.slug ? ' is-active' : ''}" href="/catalog?dept=${d.slug}">${d.title}</a>`);
    else if (d.slug === 'elektronika' && ctx.settings.electronicsTeaser) out.push(html`<span class="nav__link nav__link--soon" title="Скоро в магазине">${d.title}<small>скоро</small></span>`);
  }
  return out;
}

// Оболочка публичной страницы
function shopPage(ctx, { title, description = '', canonical = '', og = null, body, bodyClass = '', noindex = false, jsonLd = null }) {
  const s = ctx.settings;
  const fullTitle = title ? `${title} - ${s.shopName}` : `${s.shopName}: кроссовки, одежда и аксессуары`;
  const desc = description || `${s.shopName}: оригинальные кроссовки, кеды, ботинки и одежда. Доставка по России, самовывоз, примерка.`;
  const season = SEASONS[ctx.season];
  return html`<!doctype html>
<html lang="ru" data-season="${ctx.season}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${fullTitle}</title>
  <meta name="description" content="${desc}">
  ${noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
  ${canonical ? html`<link rel="canonical" href="${ctx.baseUrl}${canonical}">` : ''}
  <meta property="og:site_name" content="${s.shopName}">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${desc}">
  ${og && og.image ? html`<meta property="og:image" content="${ctx.baseUrl}${og.image}">` : ''}
  <meta name="theme-color" content="#f4eee6">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/static/fonts/inter-cyrillic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/static/css/shop.css?v=${ctx.assetV}">
  ${jsonLd ? html`<script type="application/ld+json">${raw(JSON.stringify(jsonLd).replace(/</g, '\\u003c'))}</script>` : ''}
</head>
<body class="${bodyClass}">
  ${sprite()}
  <div class="announce">
    <div class="wrap announce__in">
      <span>${icon(SEASON_ICON[ctx.season])} ${season.title}: новая подборка уже на витрине</span>
      <span class="announce__sep">Бесплатная доставка от ${rub(ctx.freeFrom)}</span>
      <span class="announce__sep">Оригинал · Самовывоз с примеркой</span>
    </div>
  </div>
  <header class="head" id="head">
    <div class="wrap head__in">
      <button class="head__burger iconbtn" type="button" data-nav-toggle aria-label="Меню">${icon('sliders')}</button>
      <a class="logo" href="/" aria-label="${s.shopName}">
        <svg class="logo__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 21c0-2 1-3 3-3.4l4.6-.9c1.6-.3 2.7-1.3 3.4-2.8l1-2.1 4.2 2.2c1.6.8 3.2 1.4 4.8 1.8 2.5.6 4 1.6 4 3.7V24H3v-3Z"/><path class="logo__sole" d="M3 26h26"/></svg>
        <span class="logo__text">${s.shopName}</span>
      </a>
      <nav class="nav" id="nav" aria-label="Разделы">
        ${navDepts(ctx)}
        ${ctx.saleCount ? html`<a class="nav__link nav__link--hot" href="/catalog?sale=1&amp;sort=discount">Скидки</a>` : ''}
        <a class="nav__link" href="/catalog?sort=new">Новинки</a>
        <a class="nav__link" href="/delivery">Доставка и оплата</a>
      </nav>
      <div class="head__tools">
        <button class="iconbtn" type="button" data-search-open aria-label="Поиск">${icon('search')}</button>
        <a class="iconbtn cartbtn" href="/cart" aria-label="Корзина">${icon('bag')}<span class="cartbtn__n${ctx.cartCount ? '' : ' is-empty'}" data-cart-count>${ctx.cartCount || ''}</span></a>
      </div>
    </div>
    <div class="search" id="search" hidden>
      <div class="wrap">
        <form class="search__form" action="/catalog" method="get" role="search">
          ${icon('search')}
          <input class="search__input" type="search" name="q" placeholder="Модель, бренд или артикул: например, «dunk low» или «9060»" autocomplete="off" aria-label="Поиск по магазину" data-search-input>
          <button class="search__close iconbtn" type="button" data-search-close aria-label="Закрыть">${icon('close')}</button>
        </form>
        <div class="search__out" data-search-out></div>
      </div>
    </div>
  </header>
  <main id="main">${body}</main>
  <footer class="foot">
    <div class="wrap foot__grid">
      <div>
        <div class="logo logo--foot"><span class="logo__text">${s.shopName}</span></div>
        <p class="foot__lead">Оригинальные кроссовки, кеды, ботинки и одежда. Доставляем по всей России, примерка при самовывозе.</p>
      </div>
      <div>
        <h4>Магазин</h4>
        <ul>
          ${Object.values(DEPARTMENTS).filter((d) => ctx.deptCounts[d.slug] > 0).map((d) => html`<li><a href="/catalog?dept=${d.slug}">${d.title}</a></li>`)}
          <li><a href="/catalog?sort=new">Новинки</a></li>
        </ul>
      </div>
      <div>
        <h4>Покупателям</h4>
        <ul>
          <li><a href="/delivery">Доставка и оплата</a></li>
          <li><a href="/delivery#return">Обмен и возврат</a></li>
          <li><a href="/cart">Корзина</a></li>
        </ul>
      </div>
      <div>
        <h4>Контакты</h4>
        <ul class="foot__contacts">
          <li>${icon('phone')}<a href="tel:${String(s.phone).replace(/[^+\d]/g, '')}">${s.phone}</a></li>
          <li>${icon('mail')}<a href="mailto:${s.email}">${s.email}</a></li>
          <li>${icon('pin')}<span>${s.address}</span></li>
          <li>${icon('clock')}<span>${s.hours}</span></li>
        </ul>
      </div>
    </div>
    <div class="wrap foot__bottom">
      <span>© ${new Date().getFullYear()} ${s.shopName}</span>
      <span>Цены и наличие обновляются автоматически из складской системы</span>
    </div>
  </footer>
  <div class="cookie" id="cookie" hidden>
    <p>Мы используем cookie: чтобы работала корзина и считалась статистика посещений.</p>
    <button class="btn btn--sm" type="button" data-cookie-ok>Понятно</button>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  <script src="/static/js/shop.js?v=${ctx.assetV}" defer></script>
</body>
</html>`;
}

const countLabel = (n) => `${n} ${plural(n, 'модель', 'модели', 'моделей')}`;

module.exports = { shopPage, card, pagination, photoUrl, sizeRange, badgeOf, priceBlock, countLabel, SEASON_ICON, esc };
