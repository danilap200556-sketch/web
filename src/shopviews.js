'use strict';
// Общие блоки витрины: оболочка страницы, карточка товара, цена, постраничная навигация.
const { html, esc, raw } = require('./html');
const { icon, sprite } = require('./icons');
const { rub, plural } = require('./util');
const { DEPARTMENTS } = require('./model');
const { SEASONS } = require('./seasons');

const SEASON_ICON = { winter: 'snow', spring: 'flower', summer: 'sun', autumn: 'leaf' };

// Отрицательный номер - фото товара партнёра (см. ext.js)
const photoUrl = (id, w = 640) => (id < 0 ? `/media/x/${-id}/${w}.jpg` : `/media/p/${id}/${w}.jpg`);

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

// Карточка: фото на светлой плашке, ярлык, «в избранное», размеры в наличии всплывают при наведении
function card(m, { priority = false, fav = false } = {}) {
  const b = badgeOf(m);
  const second = m.photos[1];
  const sizes = sizeRange(m);
  const quick = [...new Set(m.sizes.filter((x) => x.qty > 0 && x.size).map((x) => x.size))];
  return html`<div class="card${m.inStock ? '' : ' is-out'}" data-model="${m.key}">
    <a class="card__a" href="/p/${m.slug}">
      <div class="card__media">
        ${m.cover ? html`<img class="card__img" src="${photoUrl(m.cover, 640)}" srcset="${photoUrl(m.cover, 360)} 360w, ${photoUrl(m.cover, 640)} 640w"
          sizes="(max-width: 720px) 46vw, (max-width: 1100px) 30vw, 300px" alt="${m.title}" width="640" height="640"
          ${priority ? raw('fetchpriority="high"') : raw('loading="lazy" decoding="async"')}>` : ''}
        ${second ? html`<img class="card__img card__img--alt" src="${photoUrl(second, 640)}" alt="" width="640" height="640" loading="lazy" decoding="async">` : ''}
        ${b ? html`<span class="badge badge--${b.kind}">${b.text}</span>` : ''}
        ${quick.length > 1 ? html`<span class="card__quick" aria-hidden="true">${quick.slice(0, 9).map((x) => html`<i>${x}</i>`)}${quick.length > 9 ? html`<i>+${quick.length - 9}</i>` : ''}</span>` : ''}
      </div>
      <div class="card__body">
        <div class="card__stock${m.inStock ? ' is-in' : ''}">${m.inStock ? 'В наличии' : 'Нет в наличии'}</div>
        <div class="card__meta">${[m.brand, m.type].filter(Boolean).join(' · ')}</div>
        <h3 class="card__title">${m.model || m.title}</h3>
        ${m.colorway ? html`<div class="card__color">${m.colorway}</div>` : ''}
        <div class="card__foot">
          <span class="card__price">${priceBlock(m)}</span>
          ${sizes ? html`<span class="card__sizes">${sizes}</span>` : ''}
        </div>
      </div>
    </a>
    ${favBtn(m, fav)}
  </div>`;
}

// Кнопка «в избранное». Избранное хранится в cookie fav (адреса моделей через «.»), его ведёт v4.js
function favBtn(m, on, cls = 'fav') {
  return html`<button class="${cls}${on ? ' is-on' : ''}" type="button" data-fav="${m.slug}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${on ? 'Убрать из избранного' : 'В избранное'}">${icon('heart')}</button>`;
}

// Избранное из cookie: только похожие на адрес модели значения, не больше 60
function favSlugs(req) {
  const raw0 = (req.cookies && req.cookies.fav) || '';
  return [...new Set(String(raw0).split('.').filter((x) => /^[a-z0-9-]{1,120}$/.test(x)))].slice(0, 60);
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

// Строка разделов: скидки, новинки, отделы, бренды
function navLinks(ctx) {
  const out = [];
  if (ctx.saleCount) out.push(html`<a class="nav__link nav__link--hot${ctx.navActive === 'sale' ? ' is-active' : ''}" href="/catalog?sale=1&amp;sort=discount">Скидки</a>`);
  out.push(html`<a class="nav__link${ctx.navActive === 'new' ? ' is-active' : ''}" href="/catalog?sort=new">Новинки</a>`);
  for (const d of Object.values(DEPARTMENTS)) {
    const has = ctx.deptCounts[d.slug] > 0;
    if (has) out.push(html`<a class="nav__link${ctx.dept === d.slug ? ' is-active' : ''}" href="/catalog?dept=${d.slug}">${d.title}</a>`);
    else if (d.slug === 'elektronika' && ctx.settings.electronicsTeaser) out.push(html`<span class="nav__link nav__link--soon" title="Скоро в магазине">${d.title}<small>скоро</small></span>`);
  }
  out.push(html`<a class="nav__link${ctx.navActive === 'brands' ? ' is-active' : ''}" href="/brands">Бренды</a>`);
  out.push(html`<a class="nav__link" href="/delivery">Доставка</a>`);
  return out;
}

// Логотип словом: название магазина жирными заглавными, вторая половина длинного слова - контуром
function logoWord(name) {
  const n = String(name || '').trim();
  const parts = n.split(/\s+/);
  if (parts.length > 1) return html`<span class="logo__text">${parts[0]}<i>${parts.slice(1).join(' ')}</i></span>`;
  if (n.length >= 8) { const k = Math.ceil(n.length / 2); return html`<span class="logo__text">${n.slice(0, k)}<i>${n.slice(k)}</i></span>`; }
  return html`<span class="logo__text">${n}</span>`;
}

// Ссылка на Telegram из настроек: @имя, t.me/имя или полный адрес
function telegramUrl(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https:\/\/(t\.me|telegram\.me)\//i.test(t)) return t;
  const m = /^(?:@|(?:https?:\/\/)?(?:t\.me|telegram\.me)\/)?([A-Za-z0-9_]{4,64})$/.exec(t);
  return m ? `https://t.me/${m[1]}` : '';
}

// Оболочка публичной страницы
function shopPage(ctx, { title, description = '', canonical = '', og = null, body, bodyClass = '', noindex = false, jsonLd = null }) {
  const s = ctx.settings;
  const fullTitle = title ? `${title} - ${s.shopName}` : `${s.shopName}: кроссовки, одежда и аксессуары`;
  const desc = description || `${s.shopName}: оригинальные кроссовки, кеды, ботинки и одежда. Доставка по России, самовывоз, примерка.`;
  const season = SEASONS[ctx.season];
  const tel = String(s.phone || '').replace(/[^+\d]/g, '');
  const tg = telegramUrl(s.telegram);
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
  <meta name="theme-color" content="#000000">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/static/fonts/inter-cyrillic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/static/css/shop.css?v=${ctx.assetV}">
  <link rel="stylesheet" href="/static/css/design.css?v=${ctx.assetV}">
  <link rel="stylesheet" href="/static/css/v4.css?v=${ctx.assetV}">
  <script src="/static/js/boot.js?v=${ctx.assetV}"></script>
  ${jsonLd ? html`<script type="application/ld+json">${raw(JSON.stringify(jsonLd).replace(/</g, '\\u003c'))}</script>` : ''}
</head>
<body class="${bodyClass}">
  ${sprite()}
  <div class="progress" data-progress aria-hidden="true"></div>
  <div class="announce" data-ticker>
    <div class="wrap announce__in">
      <button class="announce__arrow" type="button" data-ticker-prev aria-label="Предыдущее сообщение">${icon('chevron-left')}</button>
      <div class="announce__msgs" aria-live="polite">
        <span class="announce__msg is-on">Только оригинальная продукция</span>
        ${ctx.freeFrom > 0 ? html`<span class="announce__msg">Бесплатная доставка от ${rub(ctx.freeFrom)}</span>` : ''}
        <span class="announce__msg">${icon(SEASON_ICON[ctx.season])} ${season.title}: новая подборка уже на витрине</span>
        <span class="announce__msg">Самовывоз с примеркой · обмен и возврат 7 дней</span>
      </div>
      <button class="announce__arrow" type="button" data-ticker-next aria-label="Следующее сообщение">${icon('chevron-right')}</button>
    </div>
  </div>
  <div class="util">
    <div class="wrap util__in">
      <div class="util__group">
        ${s.phone ? html`<a href="tel:${tel}">${icon('phone')}${s.phone}</a>` : ''}
        ${tg ? html`<a href="${tg}" rel="noopener" target="_blank">${icon('send')}Telegram</a>` : ''}
        <a href="/delivery">${icon('truck')}Доставка и оплата</a>
        <a href="/delivery#return">${icon('return')}Обмен и возврат</a>
      </div>
      <div class="util__group">
        ${s.hours ? html`<span>${icon('clock')}${s.hours}</span>` : ''}
        ${s.address ? html`<span>${icon('pin')}${s.address}</span>` : ''}
      </div>
    </div>
  </div>
  <header class="head" id="head">
    <div class="wrap head__in">
      <button class="head__burger iconbtn" type="button" data-nav-toggle aria-label="Меню" aria-expanded="false" aria-controls="drawer">${icon('menu')}</button>
      <a class="logo" href="/" aria-label="${s.shopName}">${logoWord(s.shopName)}</a>
      <button class="headsearch" type="button" data-search-open aria-label="Поиск">${icon('search')}<span>Поиск: модель, бренд или артикул</span><kbd>/</kbd></button>
      <div class="head__tools">
        <button class="iconbtn head__find" type="button" data-search-open aria-label="Поиск">${icon('search')}</button>
        <a class="iconbtn favbtn" href="/favorites" aria-label="Избранное">${icon('heart')}<span class="cartbtn__n${ctx.favCount ? '' : ' is-empty'}" data-fav-count>${ctx.favCount || ''}</span></a>
        <a class="iconbtn cartbtn" href="/cart" aria-label="Корзина">${icon('bag')}<span class="cartbtn__n${ctx.cartCount ? '' : ' is-empty'}" data-cart-count>${ctx.cartCount || ''}</span><span class="cartbtn__t">Корзина</span></a>
      </div>
    </div>
    <nav class="nav" id="nav" aria-label="Разделы">
      <div class="wrap nav__in">
        ${navLinks(ctx)}
      </div>
    </nav>
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
  <div class="drawer" id="drawer" aria-hidden="true">
    <div class="drawer__scrim" data-drawer-close></div>
    <aside class="drawer__panel" role="dialog" aria-modal="true" aria-label="Меню">
      <div class="drawer__top">
        <a class="logo" href="/" aria-label="${s.shopName}">${logoWord(s.shopName)}</a>
        <button class="iconbtn" type="button" data-drawer-close aria-label="Закрыть меню">${icon('close')}</button>
      </div>
      <nav class="drawer__nav" aria-label="Разделы">
        ${navLinks(ctx)}
        <a class="nav__link" href="/favorites">Избранное${ctx.favCount ? html` <small class="drawer__badge">${ctx.favCount}</small>` : ''}</a>
        <a class="nav__link" href="/cart">Корзина${ctx.cartCount ? html` <small class="drawer__badge">${ctx.cartCount}</small>` : ''}</a>
      </nav>
      <div class="drawer__foot">
        ${s.phone ? html`<a class="drawer__phone" href="tel:${String(s.phone).replace(/[^+\d]/g, '')}">${s.phone}</a>` : ''}
        ${s.hours ? html`<p>${s.hours}</p>` : ''}
        ${s.address ? html`<p>${s.address}</p>` : ''}
      </div>
    </aside>
  </div>
  <div class="minicart" id="minicart" aria-hidden="true">
    <div class="minicart__scrim" data-mini-close></div>
    <aside class="minicart__panel" role="dialog" aria-modal="true" aria-label="Корзина">
      <header class="minicart__head"><h2>Корзина <small data-mini-count></small></h2><button class="iconbtn" type="button" data-mini-close aria-label="Закрыть корзину">${icon('close')}</button></header>
      <div class="minicart__free" data-mini-free hidden><p data-mini-free-text></p><div class="minicart__bar"><i data-mini-free-fill></i></div></div>
      <div class="minicart__body" data-mini-body></div>
      <footer class="minicart__foot" hidden>
        <div class="minicart__sum"><span>Товары</span><b data-mini-sum></b></div>
        <p class="minicart__note">Доставку и скидки посчитаем на следующем шаге</p>
        <a class="btn btn--lg btn--block" href="/checkout">Оформить заказ ${icon('arrow-right')}</a>
        <a class="link link--center" href="/cart">Открыть корзину</a>
      </footer>
    </aside>
  </div>
  <main id="main">${body}</main>
  <section class="subscribe">
    <div class="wrap subscribe__in">
      <div><b>Новинки и скидки первыми</b><span>Подпишитесь на наш Telegram: поступления, размеры и закрытые распродажи.</span></div>
      ${tg ? html`<a class="btn btn--light" href="${tg}" rel="noopener" target="_blank">${icon('send')} Подписаться</a>` : html`<a class="btn btn--light" href="/catalog?sort=new">Смотреть новинки ${icon('arrow-right')}</a>`}
    </div>
  </section>
  <footer class="foot">
    <div class="wrap foot__grid">
      <div class="foot__brand">
        <a class="logo logo--foot" href="/" aria-label="${s.shopName}">${logoWord(s.shopName)}</a>
        <p class="foot__lead">Оригинальные кроссовки, кеды, ботинки и одежда. Доставляем по всей России, примерка при самовывозе.</p>
        <ul class="foot__pay" aria-label="Способы оплаты"><li>СБП</li><li>МИР</li><li>Visa</li><li>Mastercard</li><li>Перевод</li></ul>
      </div>
      <div>
        <h4>Каталог</h4>
        <ul>
          ${Object.values(DEPARTMENTS).filter((d) => ctx.deptCounts[d.slug] > 0).map((d) => html`<li><a href="/catalog?dept=${d.slug}">${d.title}</a></li>`)}
          <li><a href="/catalog?sort=new">Новинки</a></li>
          ${ctx.saleCount ? html`<li><a href="/catalog?sale=1&amp;sort=discount">Скидки</a></li>` : ''}
          <li><a href="/brands">Бренды</a></li>
        </ul>
      </div>
      <div>
        <h4>Покупателям</h4>
        <ul>
          <li><a href="/delivery">Доставка и оплата</a></li>
          <li><a href="/delivery#return">Обмен и возврат</a></li>
          <li><a href="/favorites">Избранное</a></li>
          <li><a href="/cart">Корзина</a></li>
        </ul>
      </div>
      <div>
        <h4>Контакты</h4>
        <ul class="foot__contacts">
          <li>${icon('phone')}<a href="tel:${tel}">${s.phone}</a></li>
          <li>${icon('mail')}<a href="mailto:${s.email}">${s.email}</a></li>
          ${tg ? html`<li>${icon('send')}<a href="${tg}" rel="noopener" target="_blank">Telegram</a></li>` : ''}
          <li>${icon('pin')}<span>${s.address}</span></li>
          <li>${icon('clock')}<span>${s.hours}</span></li>
        </ul>
      </div>
    </div>
    <div class="foot__word" aria-hidden="true">${s.shopName}</div>
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
  <script src="/static/js/fx.js?v=${ctx.assetV}" defer></script>
  <script src="/static/js/hero.js?v=${ctx.assetV}" defer></script>
  <script src="/static/js/v4.js?v=${ctx.assetV}" defer></script>
</body>
</html>`;
}

const countLabel = (n) => `${n} ${plural(n, 'модель', 'модели', 'моделей')}`;

module.exports = { shopPage, card, favBtn, favSlugs, telegramUrl, pagination, photoUrl, sizeRange, badgeOf, priceBlock, countLabel, SEASON_ICON, esc };
