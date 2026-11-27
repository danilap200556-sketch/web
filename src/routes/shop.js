'use strict';
const { html, raw } = require('../html');
const { icon } = require('../icons');
const { rub, plural, num } = require('../util');
const { DEPARTMENTS } = require('../model');
const { SEASONS, heroFor, seasonPicks } = require('../seasons');
const { card, pagination, photoUrl, countLabel, priceBlock, favBtn, favSlugs, telegramUrl, mapBlock, SEASON_ICON } = require('../shopviews');
const { socialList, renderText } = require('../site');
const { guideBlock, guidePage, sizeGuideButton } = require('../sizecharts');
const { quote, PAY_METHODS } = require('../delivery');

const SIZES_QUICK = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'];

const { SPEC_FACETS, CHILD_PARAMS } = require('../specs');

module.exports = function mount(app, { catalog, tracker, cfg, media, partner, pages }, shopCtx, send) {
  // ---------- Главная ----------
  app.get('/', shopCtx, async (req, res, next) => {
    try {
    const ctx = req.ctx;
    tracker.record(req, res, 'page', { path: '/' });
    const season = ctx.season;
    const day = new Date().toISOString().slice(0, 10);
    const picks = seasonPicks(catalog.models, season, 12, day);
    // В hero нужны фото на чистом светлом фоне: на цветном вокруг обуви остаётся «рамка»
    const heroPool = seasonPicks(catalog.models, season, 24, day);
    const heroModels = [];
    for (const m of heroPool) {
      if (heroModels.length >= 3) break;
      if (await media.isClean(m.cover)) heroModels.push(m);
    }
    for (const m of heroPool) if (heroModels.length < 3 && !heroModels.includes(m)) heroModels.push(m);
    const hero = heroFor(season, ctx.settings);
    // Фон первого экрана: своё видео или фото из админки («Витрина и каталог»), иначе живой фон в цветах сезона
    const heroMedia = ctx.settings.heroMedia && ctx.settings.heroMedia.id ? ctx.settings.heroMedia : null;
    const newest = catalog.newest(8, (m) => m.cover);
    const onSale = catalog.onSale(8);
    const brands = [...catalog.models.filter((m) => m.inStock && m.brand).reduce((acc, m) => acc.set(m.brand, (acc.get(m.brand) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    const cat = (type, title, filter) => {
      const list = catalog.models.filter((m) => m.inStock && m.cover && filter(m));
      return { title, count: list.length, cover: (list.find((m) => m.featured) || list.sort((a, b) => b.qty - a.qty)[0] || {}).cover, href: filter.href };
    };
    const tiles = [
      Object.assign(cat('sneakers', 'Кроссовки', (m) => m.type === 'Кроссовки'), { href: '/catalog?type=Кроссовки' }),
      Object.assign(cat('kedy', 'Кеды', (m) => m.type === 'Кеды'), { href: '/catalog?type=Кеды' }),
      Object.assign(cat('boots', 'Ботинки и угги', (m) => m.type === 'Ботинки' || m.type === 'Угги'), { href: '/catalog?type=Ботинки&type=Угги' }),
      Object.assign(cat('slides', 'Шлёпанцы и сабо', (m) => ['Шлёпанцы', 'Сабо', 'Слайды', 'Мюли'].includes(m.type)), { href: '/catalog?type=Шлёпанцы&type=Сабо&type=Слайды&type=Мюли' }),
      Object.assign(cat('clothes', 'Одежда', (m) => m.dept === 'clothes'), { href: '/catalog?dept=odezhda' }),
      Object.assign(cat('acc', 'Сумки и аксессуары', (m) => m.dept === 'accessories'), { href: '/catalog?dept=aksessuary' }),
    ].filter((t) => t.count > 0 && t.cover);

    // Электроника партнёра: плитка категории, блок на главной
    const elec = catalog.models.filter((m) => m.dept === 'electronics' && m.inStock && m.cover);
    const elecPicks = [];
    const seenBrand = new Set();
    for (const m of elec.slice().sort((x, y) => Number(y.featured) - Number(x.featured) || y.price - x.price)) {
      if (elecPicks.length >= 4) break;
      if (seenBrand.has(m.brand)) continue;
      seenBrand.add(m.brand); elecPicks.push(m);
    }
    for (const m of elec) if (elecPicks.length < 4 && !elecPicks.includes(m)) elecPicks.push(m);
    const elecBrands = [...elec.reduce((acc, m) => (m.brand ? acc.set(m.brand, (acc.get(m.brand) || 0) + 1) : acc), new Map())].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([b]) => b);
    const inStockCount = catalog.models.filter((m) => m.inStock).length;
    const marquee = [...new Set([...brands.map(([b]) => b), ...elecBrands])].slice(0, 16);
    const railHead = (title, link, sub = '') => html`<div class="block__head"><div><h2>${title}</h2>${sub ? html`<p class="block__sub">${sub}</p>` : ''}</div>
      <div class="rail__ctl">${link || ''}<div class="rail__nav"><button type="button" class="rail__btn" data-rail-prev aria-label="Назад">${icon('arrow-right')}</button><button type="button" class="rail__btn" data-rail-next aria-label="Вперёд">${icon('arrow-right')}</button></div></div></div>`;
    const maxOff = onSale.reduce((mx, m) => Math.max(mx, m.discount || 0), 0);
    const salePics = onSale.filter((m) => m.cover).slice(0, 2);
    const newPick = newest.find((m) => m.inStock) || newest[0];

    // Слайды баннера: сезон (живой фон или своё видео/фото из админки), скидки, новинки, электроника
    const slides = [];
    slides.push(html`<article class="slide slide--season${heroMedia ? ' hero--media' : ''}" data-hero>
      <div class="hero__bg" aria-hidden="true">
        <div class="hero__fallback"></div>
        ${heroMedia && heroMedia.kind === 'image'
          ? html`<img class="hero__photo" src="/media/hero/${heroMedia.id}" alt="" fetchpriority="high" decoding="async">`
          : html`<canvas class="hero__gl" data-hero-gl></canvas>`}
        ${heroMedia && heroMedia.kind === 'video' ? html`<video class="hero__video" muted loop playsinline preload="none" data-hero-video data-src="/media/hero/${heroMedia.id}"></video>` : ''}
        <div class="hero__shade"></div>
      </div>
      <div class="slide__in">
        <div class="slide__copy">
          <p class="slide__eyebrow">${icon(SEASON_ICON[season])} ${hero.eyebrow} ${new Date().getFullYear()}</p>
          <h1 class="slide__title">${hero.title}</h1>
          <p class="slide__text">${hero.text}</p>
          <div class="slide__cta">
            <a class="btn btn--light btn--lg" href="#picks">Смотреть подборку ${icon('arrow-right')}</a>
            <a class="btn btn--glass btn--lg" href="/catalog">Весь каталог</a>
          </div>
        </div>
        ${heroModels.length ? html`<div class="spot" data-spot>
          <div class="spot__card">
            <div class="spot__bars">${heroModels.map((m, i) => html`<button type="button" class="spot__bar${i === 0 ? ' is-active' : ''}" data-spot-go="${i}" aria-label="${m.brand} ${m.model}: модель ${i + 1} из ${heroModels.length}"><i></i></button>`)}</div>
            ${heroModels.map((m, i) => html`<a class="spot__item${i === 0 ? ' is-active' : ''}" href="/p/${m.slug}" data-spot-item ${i ? raw('tabindex="-1" aria-hidden="true"') : ''}>
              <img src="${photoUrl(m.cover, 640)}" alt="${m.title}" width="640" height="640" ${i === 0 ? raw('fetchpriority="high"') : raw('loading="lazy"')}>
              <span class="spot__info"><small>${m.brand}${m.type ? ' · ' + m.type : ''}</small><b>${m.model || m.title}</b><span>${rub(m.price)}</span></span>
            </a>`)}
          </div>
        </div>` : ''}
      </div>
    </article>`);
    if (onSale.length >= 2 && maxOff > 0) slides.push(html`<article class="slide slide--sale">
      <div class="slide__in">
        <div class="slide__copy">
          <p class="slide__kicker">Sale</p>
          <p class="slide__big"><small>до</small><b>${maxOff}%</b></p>
          <p class="slide__caps">на ${num(ctx.saleCount)} ${plural(ctx.saleCount, 'модель', 'модели', 'моделей')} в наличии</p>
          <div class="slide__cta"><a class="btn btn--lg" href="/catalog?sale=1&amp;sort=discount">Смотреть все скидки ${icon('arrow-right')}</a></div>
        </div>
        <div class="slide__pics" aria-hidden="true">
          <i class="streak streak--sale"></i>
          ${salePics.map((m, i) => html`<img class="slide__pic slide__pic--${i + 1}" src="${photoUrl(m.cover, 640)}" alt="" width="640" height="640" loading="lazy">`)}
        </div>
      </div>
    </article>`);
    if (newPick && newPick.cover) slides.push(html`<article class="slide slide--new">
      <div class="slide__in">
        <div class="slide__pics" aria-hidden="true"><img class="slide__pic" src="${photoUrl(newPick.cover, 1280)}" alt="" width="1280" height="1280" loading="lazy"></div>
        <div class="slide__copy">
          <p class="slide__new">New</p>
          <h2 class="slide__title">Выбери свою модель</h2>
          <p class="slide__text">Новые поступления каждую неделю: ${[...new Set(newest.map((m) => m.brand).filter(Boolean))].slice(0, 4).join(', ')} и другие.</p>
          <div class="slide__cta"><a class="btn btn--outline btn--lg" href="/catalog?sort=new">Перейти в каталог</a></div>
        </div>
      </div>
    </article>`);
    if (elecPicks.length) slides.push(html`<article class="slide slide--elec">
      <div class="slide__in">
        <div class="slide__copy">
          <p class="slide__eyebrow">${icon('chip')} Новый раздел</p>
          <h2 class="slide__title">Электроника</h2>
          <p class="slide__text">${elecBrands.join(', ')} и другие бренды. Наличие и цены обновляются каждые несколько часов.</p>
          <div class="slide__cta"><a class="btn btn--light btn--lg" href="/catalog?dept=elektronika">Смотреть ${icon('arrow-right')}</a></div>
        </div>
        <div class="slide__pics" aria-hidden="true">${elecPicks.slice(0, 3).map((m, i) => html`<span class="slide__chip slide__chip--${i + 1}"><img src="${photoUrl(m.cover, 360)}" alt="" width="360" height="360" loading="lazy"></span>`)}</div>
      </div>
    </article>`);

    const body = html`
    <section class="banner" data-banner aria-roledescription="carousel" aria-label="Главные предложения">
      <div class="wrap banner__wrap">
        <div class="banner__track" data-banner-track>
          ${slides.map((sl, i) => html`<div class="banner__slide" role="group" aria-roledescription="slide" aria-label="${i + 1} из ${slides.length}" data-banner-slide>${sl}</div>`)}
        </div>
        ${slides.length > 1 ? html`<button class="banner__arrow banner__arrow--prev" type="button" data-banner-prev aria-label="Предыдущий слайд">${icon('chevron-left')}</button>
        <button class="banner__arrow banner__arrow--next" type="button" data-banner-next aria-label="Следующий слайд">${icon('chevron-right')}</button>
        <div class="banner__dots">${slides.map((_, i) => html`<button type="button" class="banner__dot${i === 0 ? ' is-active' : ''}" data-banner-dot="${i}" aria-label="Слайд ${i + 1}"><i></i></button>`)}</div>` : ''}
      </div>
    </section>

    ${marquee.length ? html`<div class="marquee" aria-label="Бренды">
      <div class="marquee__track">${[0, 1].map((k) => html`<ul class="marquee__list" ${k ? raw('aria-hidden="true"') : ''}>${marquee.map((b) => html`<li><a href="/catalog?brand=${encodeURIComponent(b)}" ${k ? raw('tabindex="-1"') : ''}>${b}</a></li>`)}</ul>`)}</div>
    </div>` : ''}

    <section class="usp">
      <div class="wrap usp__grid">
        <div class="usp__item">${icon('shield')}<div><b>Только оригинал</b><span>Проверяем каждую пару</span></div></div>
        <div class="usp__item">${icon('truck')}<div><b>Доставка по России</b><span>${ctx.freeFrom > 0 ? `Бесплатно от ${rub(ctx.freeFrom)}` : 'СДЭК, Boxberry, Почта, курьер'}</span></div></div>
        <div class="usp__item">${icon('store')}<div><b>Самовывоз с примеркой</b><span>Заберите сегодня</span></div></div>
        <div class="usp__item">${icon('return')}<div><b>Обмен и возврат</b><span>7 дней на решение</span></div></div>
      </div>
    </section>

    ${picks.length ? html`<section class="block" id="picks">
      <div class="wrap" data-rail data-reveal>
        ${railHead(`${SEASONS[season].title}: выбор сезона`, html`<a class="link rail__all" href="/catalog?sort=popular">Смотреть все ${icon('arrow-right')}</a>`)}
        <div class="rail__track">${picks.map((m, i) => card(m, { priority: i < 4 }))}</div>
      </div>
    </section>` : ''}

    ${tiles.length ? html`<section class="block">
      <div class="wrap">
        <div class="block__head" data-reveal><div><h2>Категории</h2></div><div class="rail__ctl"><a class="link rail__all" href="/catalog">Весь каталог ${icon('arrow-right')}</a></div></div>
        <div class="tiles">
          ${tiles.map((t) => html`<a class="tile" href="${t.href}" data-reveal>
            <span class="tile__img"><img src="${photoUrl(t.cover, 640)}" alt="" width="640" height="640" loading="lazy"></span>
            <span class="tile__t"><b>${t.title}</b><i>${t.count} ${plural(t.count, 'модель', 'модели', 'моделей')}</i></span>
          </a>`)}
        </div>
      </div>
    </section>` : ''}

    <section class="block block--tight">
      <div class="wrap">
        <div class="paybar" data-reveal>
          <div><b>Оплачивайте как удобно</b><span>СБП по QR-коду, перевод по реквизитам${ctx.freeFrom > 0 ? html`, бесплатная доставка от ${rub(ctx.freeFrom)}` : ''}</span></div>
          <ul class="paybar__list"><li>${icon('qr')} СБП</li><li>${icon('card')} Карта</li><li>${icon('bank')} Перевод</li><li>${icon('cash')} При получении</li></ul>
        </div>
      </div>
    </section>

    ${onSale.length >= 4 ? html`<section class="block">
      <div class="wrap" data-rail data-reveal>
        ${railHead(html`Скидки <span class="block__hot">до −${maxOff}%</span>`, html`<a class="link rail__all" href="/catalog?sale=1&amp;sort=discount">Все скидки ${icon('arrow-right')}</a>`)}
        <div class="rail__track">${onSale.map((m) => card(m))}</div>
      </div>
    </section>` : ''}

    ${newest.length ? html`<section class="block">
      <div class="wrap" data-rail data-reveal>
        ${railHead('Новые поступления', html`<a class="link rail__all" href="/catalog?sort=new">Все новинки ${icon('arrow-right')}</a>`)}
        <div class="rail__track">${newest.map((m) => card(m))}</div>
      </div>
    </section>` : ''}

    <section class="block block--finder" data-reveal>
      <div class="wrap">
        <div class="finder" data-finder>
          <div class="finder__copy">
            <h2>Подбор пары</h2>
            <p>Выберите тип и размер: покажем только то, что есть в вашем размере прямо сейчас.</p>
            <dl class="finder__stats">
              <div><dt data-count="${inStockCount}">${num(inStockCount)}</dt><dd>моделей в наличии</dd></div>
              <div><dt>${brands.length}</dt><dd>${plural(brands.length, 'бренд', 'бренда', 'брендов')}</dd></div>
            </dl>
          </div>
          <form class="finder__form" action="/catalog" method="get">
            <fieldset class="finder__row">
              <legend>Что ищем</legend>
              <div class="seg">
                ${[['', 'Всё'], ['Кроссовки', 'Кроссовки'], ['Кеды', 'Кеды'], ['Ботинки', 'Ботинки'], ['Шлёпанцы', 'Шлёпанцы']].map(([v, t], i) => html`<label><input type="radio" name="type" value="${v}" ${i === 1 ? raw('checked') : ''} data-finder-input><span>${t}</span></label>`)}
              </div>
            </fieldset>
            <fieldset class="finder__row">
              <legend>Ваш размер (EU)</legend>
              <div class="sizes">
                ${SIZES_QUICK.map((sz) => html`<label class="size"><input type="checkbox" name="size" value="${sz}" data-finder-input><span>${sz}</span></label>`)}
              </div>
            </fieldset>
            <fieldset class="finder__row finder__row--split">
              <label>Бренд
                <select name="brand" data-finder-input>
                  <option value="">Любой</option>
                  ${brands.map(([b, n]) => html`<option value="${b}">${b} (${n})</option>`)}
                </select>
              </label>
              <label>Цена до
                <select name="max" data-finder-input>
                  <option value="">Любая</option>
                  ${[8000, 12000, 16000, 24000].map((pr) => html`<option value="${pr}">${rub(pr)}</option>`)}
                </select>
              </label>
            </fieldset>
            <button class="btn btn--lg btn--block" type="submit" data-finder-go>Показать <span data-finder-count>${countLabel(catalog.models.filter((m) => m.inStock && m.type === 'Кроссовки').length)}</span> ${icon('arrow-right')}</button>
          </form>
        </div>
      </div>
    </section>

    ${elecPicks.length ? html`<section class="block">
      <div class="wrap" data-reveal>
        <div class="promo">
          <div class="promo__copy">
            <p class="eyebrow">${icon('chip')} Новый раздел</p>
            <h2>Электроника</h2>
            <p>${elecBrands.join(', ')} и другие бренды. Цены и наличие обновляются каждые несколько часов, заказ можно оплатить по СБП.</p>
            <a class="btn btn--light btn--lg" href="/catalog?dept=elektronika">Смотреть всё ${icon('arrow-right')}</a>
          </div>
          <div class="promo__grid">
            ${elecPicks.map((m) => html`<a class="promo__item" href="/p/${m.slug}">
              <span class="promo__img"><img src="${photoUrl(m.cover, 360)}" alt="${m.title}" width="360" height="360" loading="lazy"></span>
              <small>${m.brand}</small><b>${m.model}</b><span class="promo__price">${rub(m.price)}</span>
            </a>`)}
          </div>
        </div>
      </div>
    </section>` : ''}

    ${ctx.settings.electronicsTeaser && !ctx.deptCounts[DEPARTMENTS.electronics.slug] ? html`<section class="block block--tight">
      <div class="wrap">
        <div class="teaser">
          <div class="teaser__ic">${icon('chip')}</div>
          <div><p class="eyebrow">Скоро</p><h3>Электроника в ${ctx.settings.shopName}</h3><p>Наушники, колонки и гаджеты тех же брендов. Следите за обновлениями.</p></div>
        </div>
      </div>
    </section>` : ''}
    `;
    send(req, res, { title: '', body, bodyClass: 'page-home', canonical: '/', og: heroModels[0] ? { image: photoUrl(heroModels[0].cover, 640) } : null });
    } catch (e) { next(e); }
  });

  // ---------- Каталог ----------
  function titleFor(c) {
    if (c.q) return `Поиск: «${c.q}»`;
    if (c.sale && !c.types.length && !c.brands.length && !c.dept) return 'Скидки';
    if (c.brands.length === 1 && !c.types.length) return c.brands[0];
    if (c.types.length === 1 && !c.brands.length) return c.types[0];
    if (c.brands.length === 1 && c.types.length === 1) return `${c.brands[0]}: ${c.types[0]}`;
    if (c.dept) return Object.values(DEPARTMENTS).find((d) => d.slug === c.dept).title;
    if (c.sort === 'new') return 'Новинки';
    return 'Каталог';
  }

  // Строка запроса без page (для ссылок пагинации и сортировки)
  function qs(query, drop = []) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (drop.includes(k) || v === '' || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (x !== '') p.append(k, String(x));
    }
    return p.toString();
  }

  // Линейка (после выбора бренда или категории) и характеристики выбранной линейки: модель, память, SIM, связь, чип, диагональ, корпус.
  // Значения и числа берутся из результата поиска: они уже учитывают всё остальное, что выбрано.
  const ROW_SPECS = ['model', 'mem', 'ram', 'sim', 'net', 'chip', 'screen', 'case'];
  function specRows(c, r, btn) {
    if (!r || !r.facets || !r.facets.specs) return '';
    const sp = r.facets.specs;
    const row = (sf, cls = '') => {
      const vals = (sp[sf.param] || []).slice(0, 30);
      if (vals.length < 2 && !c[sf.crit].length) return '';
      return html`<div class="quickbar__row quickbar__row--spec${cls}"><span class="quickbar__t">${sf.title}</span>${vals.map(([v, n]) => btn(sf.param, v, n, c[sf.crit].includes(v)))}</div>`;
    };
    const fam = SPEC_FACETS.find((f) => f.param === 'fam');
    const out = [];
    if (c.brands.length || c.types.length || c.fams.length) out.push(row(fam));
    if (c.fams.length) for (const sf of SPEC_FACETS.filter((f) => ROW_SPECS.includes(f.param))) out.push(row(sf));
    return out;
  }

  // Панель кнопок для электроники: категории (с числом товаров) и бренды выбранной категории. Нажатие выбирает, повторное снимает.
  function quickBar(c, query, r) {
    if (c.dept !== DEPARTMENTS.electronics.slug) return '';
    const pool = catalog.models.filter((m) => m.dept === 'electronics' && (!c.inStock || m.inStock));
    const count = (list, key) => { const mp = new Map(); for (const m of list) if (m[key]) mp.set(m[key], (mp.get(m[key]) || 0) + 1); return [...mp].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')); };
    const types = count(pool, 'type');
    const brands = count(c.types.length ? pool.filter((m) => c.types.includes(m.type)) : pool, 'brand').slice(0, 24);
    // Адрес кнопки: текущие параметры без страницы; ключ key становится равным val, а у активной кнопки убирается
    // При смене «родителя» выбранное в зависимых сбрасывается: сменили бренд или категорию - линейка и характеристики прежнего выбора не нужны
    const reset = { type: ['fam', ...CHILD_PARAMS], brand: ['fam', ...CHILD_PARAMS], fam: CHILD_PARAMS };
    const href = (key, val, active) => {
      const p = new URLSearchParams();
      const skip = new Set(['page', ...(key ? [key] : []), ...(reset[key] || [])]);
      for (const [k, v] of Object.entries(query)) {
        if (skip.has(k)) continue;
        for (const x of Array.isArray(v) ? v : [v]) if (x !== '') p.append(k, String(x));
      }
      if (key && !active) p.append(key, val);
      return '/catalog' + (p.toString() ? '?' + p : '');
    };
    const btn = (key, val, n, active, label = val, reset = false) => (active
      ? html`<a class="is-active" href="${href(key, val, true)}" aria-pressed="true">${label} <i>${n}</i></a>`
      : html`<a href="${href(key, val, reset)}">${label} <i>${n}</i></a>`);
    if (!types.length) return '';
    return html`<nav class="quickbar" aria-label="Категории и бренды электроники">
      <div class="quickbar__row">${btn('type', '', pool.length, !c.types.length, 'Все', true)}${types.map(([t, n]) => btn('type', t, n, c.types.includes(t)))}</div>
      ${brands.length > 1 ? html`<div class="quickbar__row quickbar__row--brands"><span class="quickbar__t">Бренды</span>${brands.map(([b, n]) => btn('brand', b, n, c.brands.includes(b)))}</div>` : ''}
      ${specRows(c, r, btn)}
    </nav>`;
  }

  app.get('/catalog', shopCtx, (req, res) => {
    const ctx = req.ctx;
    const r = catalog.search(req.query);
    const c = r.criteria;
    ctx.dept = c.dept;
    tracker.record(req, res, 'page', { path: '/catalog' });
    const baseQs = qs(req.query, ['page']);
    const base = '/catalog' + (baseQs ? '?' + baseQs : '');
    const f = r.facets;
    const chips = [];
    const chip = (label, drop, val) => {
      const q2 = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k === 'page') continue;
        for (const x of Array.isArray(v) ? v : [v]) {
          if (k === drop && (val === undefined || x === val)) continue;
          if (drop === 'price' && (k === 'min' || k === 'max')) continue;
          q2.append(k, String(x));
        }
      }
      chips.push(html`<a class="fchip" href="/catalog${q2.toString() ? '?' + q2 : ''}">${label}${icon('close')}</a>`);
    };
    c.types.forEach((t) => chip(t, 'type', t));
    c.brands.forEach((b) => chip(b, 'brand', b));
    c.sizes.forEach((s) => chip('Размер ' + s, 'size', s));
    const SPEC_CHIP = { ram: (v) => `ОЗУ ${v}`, chip: (v) => `Чип ${v}`, case: (v) => `Корпус ${v}`, screen: (v) => `Экран ${v}` };
    for (const sf of SPEC_FACETS) c[sf.crit].forEach((v) => chip((SPEC_CHIP[sf.param] || ((x) => x))(v), sf.param, v));
    if (c.min || c.max) chip(`${c.min ? 'от ' + rub(c.min) : ''} ${c.max ? 'до ' + rub(c.max) : ''}`.trim(), 'price');
    if (c.q) chip(`«${c.q}»`, 'q');
    if (c.sale) chip('Со скидкой', 'sale');
    if (!c.inStock) chip('Включая отсутствующие', 'all');
    const h1 = titleFor(c);
    const hidden = (name, v) => (v ? html`<input type="hidden" name="${name}" value="${v}">` : '');
    const brandsShown = f.brands.slice(0, 40);
    const st = catalog.stats();
    const body = html`
    <section class="wrap catalog">
      <nav class="crumbs" aria-label="Путь"><a href="/">Главная</a>${icon('chevron-right')}<span>${h1}</span></nav>
      <div class="catalog__head">
        <div><h1>${h1}</h1><p class="muted">${countLabel(r.total)}${c.inStock ? ' в наличии' : ''}</p></div>
        <div class="catalog__tools">
          <button class="btn btn--ghost btn--sm filters-open" type="button" data-filters-open>${icon('sliders')} Фильтры${chips.length ? html` <b class="dot">${chips.length}</b>` : ''}</button>
          <form method="get" action="/catalog" class="sort" data-autosubmit>
            ${hidden('q', c.q)}${hidden('dept', c.dept)}${c.types.map((t) => hidden('type', t))}${c.brands.map((b) => hidden('brand', b))}${c.sizes.map((s) => hidden('size', s))}${hidden('min', c.min)}${hidden('max', c.max)}${!c.inStock ? hidden('all', '1') : ''}${c.sale ? hidden('sale', '1') : ''}${SPEC_FACETS.map((sf) => c[sf.crit].map((v) => hidden(sf.param, v)))}
            <label><span class="sort__t">Сортировка</span>
              <select name="sort" aria-label="Сортировка">
                ${[['popular', 'Сначала популярные'], ['new', 'Новинки'], ['discount', 'Больше скидка'], ['price_asc', 'Подешевле'], ['price_desc', 'Подороже']].map(([v, t]) => html`<option value="${v}" ${c.sort === v ? raw('selected') : ''}>${t}</option>`)}
              </select>
            </label>
          </form>
        </div>
      </div>
      ${quickBar(c, req.query, r)}
      ${chips.length ? html`<div class="fchips">${chips}<a class="fchips__reset" href="/catalog${c.dept ? '?dept=' + c.dept : ''}">Сбросить всё</a></div>` : ''}
      <div class="catalog__cols">
        <aside class="filters" id="filters" data-filters>
          <div class="filters__top"><b>Фильтры</b><button class="iconbtn" type="button" data-filters-close aria-label="Закрыть">${icon('close')}</button></div>
          <form method="get" action="/catalog" data-autosubmit data-count-form>
            ${hidden('q', c.q)}${hidden('dept', c.dept)}${hidden('sort', c.sort !== 'popular' ? c.sort : '')}
            ${f.types.length > 1 ? html`<details class="fgroup" open><summary>Тип</summary>
              <div class="fgroup__body">${f.types.map(([t, n]) => html`<label class="check"><input type="checkbox" name="type" value="${t}" ${c.types.includes(t) ? raw('checked') : ''}><span>${t}</span><i>${n}</i></label>`)}</div></details>` : ''}
            ${f.sizes.length ? html`<details class="fgroup" open><summary>Размер</summary>
              <div class="fgroup__body sizes">${f.sizes.map(([s, n]) => html`<label class="size" title="${n} ${plural(n, 'модель', 'модели', 'моделей')}"><input type="checkbox" name="size" value="${s}" ${c.sizes.includes(s) ? raw('checked') : ''}><span>${s}</span></label>`)}</div>
              <a class="sizelink" href="/razmery">Таблица размеров</a></details>` : ''}
            ${brandsShown.length ? html`<details class="fgroup" open><summary>Бренд</summary>
              <div class="fgroup__body fgroup__body--scroll">${brandsShown.map(([b, n]) => html`<label class="check"><input type="checkbox" name="brand" value="${b}" ${c.brands.includes(b) ? raw('checked') : ''}><span>${b}</span><i>${n}</i></label>`)}</div></details>` : ''}
            ${c.dept === DEPARTMENTS.electronics.slug ? SPEC_FACETS.map((sf) => {
              const vals = f.specs[sf.param] || [];
              if (sf.param === 'model' && !c.fams.length) return '';            // модели всех линеек сразу - слишком длинный список
              if (vals.length < 2 && !c[sf.crit].length) return '';
              return html`<details class="fgroup" ${sf.param === 'color' && !c[sf.crit].length ? '' : raw('open')}><summary>${sf.title}</summary>
                <div class="fgroup__body${vals.length > 8 ? ' fgroup__body--scroll' : ''}">${vals.map(([v, n]) => html`<label class="check"><input type="checkbox" name="${sf.param}" value="${v}" ${c[sf.crit].includes(v) ? raw('checked') : ''}><span>${v}</span><i>${n}</i></label>`)}</div></details>`;
            }) : ''}
            <details class="fgroup" ${c.min || c.max ? raw('open') : ''}><summary>Цена, ₽</summary>
              <div class="fgroup__body price-range">
                <input type="number" inputmode="numeric" name="min" min="0" step="500" placeholder="от ${f.priceMin ? num(f.priceMin) : '0'}" value="${c.min || ''}" aria-label="Цена от">
                <span>-</span>
                <input type="number" inputmode="numeric" name="max" min="0" step="500" placeholder="до ${f.priceMax ? num(f.priceMax) : ''}" value="${c.max || ''}" aria-label="Цена до">
              </div></details>
            ${st.onSale || c.sale ? html`<label class="check check--solo check--sale"><input type="checkbox" name="sale" value="1" ${c.sale ? raw('checked') : ''}><span>Только со скидкой</span></label>` : ''}
            <label class="check check--solo"><input type="checkbox" name="all" value="1" ${!c.inStock ? raw('checked') : ''}><span>Показывать и то, чего нет в наличии</span></label>
            <div class="filters__actions">
              <button class="btn btn--block" type="submit">Показать ${countLabel(r.total)}</button>
              <a class="btn btn--ghost btn--block" href="/catalog${c.dept ? '?dept=' + c.dept : ''}">Сбросить</a>
            </div>
          </form>
        </aside>
        <div class="catalog__main">
          ${r.items.length ? html`<div class="grid grid--catalog">${r.items.map((m, i) => card(m, { priority: i < 4 }))}</div>${pagination(base, r.page, r.pages)}` : html`
            <div class="empty">
              <p class="eyebrow">Ничего не нашлось</p>
              <h2>По этим условиям моделей нет</h2>
              <p>Попробуйте убрать часть фильтров${c.q ? ' или изменить запрос' : ''}. Вот бренды, которые сейчас в наличии:</p>
              <div class="brands brands--inline">${f.brands.slice(0, 8).map(([b, n]) => html`<a class="brands__item" href="/catalog?brand=${encodeURIComponent(b)}"><b>${b}</b><span>${n}</span></a>`)}</div>
              <p><a class="btn" href="/catalog">Весь каталог</a></p>
            </div>`}
        </div>
      </div>
    </section>`;
    send(req, res, {
      title: h1, body, bodyClass: 'page-catalog', canonical: c.q ? '' : '/catalog' + (qs({ dept: c.dept, type: c.types, brand: c.brands }) ? '?' + qs({ dept: c.dept, type: c.types, brand: c.brands }) : ''),
      noindex: !!c.q || c.page > 1 || c.sizes.length > 0 || !!c.min || !!c.max || c.sale || SPEC_FACETS.some((sf) => c[sf.crit].length > 0), description: `${h1}: ${countLabel(r.total)} в магазине. Цены от ${rub(f.priceMin || 0)}, доставка по России и самовывоз.`,
    });
  });

  // Старые/короткие адреса отделов
  for (const d of Object.values(DEPARTMENTS)) app.get(`/${d.slug}`, (req, res) => res.redirect(301, `/catalog?dept=${d.slug}`));

  // ---------- Карточка модели ----------
  app.get('/p/:slug', shopCtx, async (req, res, next) => {
    try {
    const ctx = req.ctx;
    const m = catalog.bySlug.get(String(req.params.slug).toLowerCase());
    if (!m) return send(req, res, {
      title: 'Модель не найдена', noindex: true,
      body: html`<section class="wrap empty"><p class="eyebrow">Нет такой модели</p><h1>Эта пара уже недоступна</h1><p>Возможно, её убрали с продажи. Посмотрите похожие в каталоге.</p><p><a class="btn" href="/catalog">В каталог ${icon('arrow-right')}</a></p></section>`,
    }, 404);
    tracker.record(req, res, 'product', { path: `/p/${m.slug}`, model_key: m.key });
    ctx.dept = DEPARTMENTS[m.dept].slug;
    const related = catalog.related(m, 4);
    const availSizes = m.sizes.filter((s) => s.qty > 0);
    const firstFree = m.sizes.find((s) => s.price && s.qty > 0);
    const photos = m.photos.slice(0, 8);
    const isExt = Boolean(m.ext); // электроника партнёра: один вариант без размеров
    const descr = isExt ? await partner.description(m.ext.id) : m.description;
    if (isExt) partner.refreshDetail(m.ext.id).catch(() => {}); // карточка у партнёра подгружается в фоне: фото станут чётче
    const jsonLd = {
      '@context': 'https://schema.org', '@type': 'Product', name: m.title, brand: m.brand ? { '@type': 'Brand', name: m.brand } : undefined,
      sku: m.key, image: photos.map((id) => `${ctx.baseUrl}${photoUrl(id, 1280)}`),
      description: descr || `${m.fullName}. Оригинал, доставка по России.`,
      offers: { '@type': 'Offer', priceCurrency: 'RUB', price: String(m.price), ...(m.oldPrice && m.saleTo ? { priceValidUntil: m.saleTo } : {}), availability: m.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: `${ctx.baseUrl}/p/${m.slug}` },
    };
    const d = ctx.deliveryData;
    const minDelivery = d.methods.filter((x) => x.active).map((x) => ({ x, q: quote(x, m.price, false) })).sort((a, b) => a.q.price - b.q.price)[0];
    const body = html`
    <section class="wrap pdp">
      <nav class="crumbs" aria-label="Путь"><a href="/">Главная</a>${icon('chevron-right')}<a href="/catalog?dept=${DEPARTMENTS[m.dept].slug}">${DEPARTMENTS[m.dept].title}</a>${m.type ? html`${icon('chevron-right')}<a href="/catalog?type=${encodeURIComponent(m.type)}">${m.type}</a>` : ''}${icon('chevron-right')}<span>${m.title}</span></nav>
      <div class="pdp__cols">
        <div class="gallery" data-gallery>
          <div class="gallery__main">
            ${photos.length ? html`<img src="${photoUrl(photos[0], 1280)}" srcset="${photoUrl(photos[0], 640)} 640w, ${photoUrl(photos[0], 1280)} 1280w" sizes="(max-width: 900px) 100vw, 56vw" alt="${m.title}" width="1280" height="1280" data-gallery-main fetchpriority="high">` : ''}
          </div>
          ${photos.length > 1 ? html`<div class="gallery__thumbs">${photos.map((id, i) => html`<button type="button" class="gallery__thumb${i === 0 ? ' is-active' : ''}" data-gallery-thumb data-full="${photoUrl(id, 1280)}" data-mid="${photoUrl(id, 640)}" aria-label="Фото ${i + 1}"><img src="${photoUrl(id, 360)}" alt="" width="120" height="120" loading="lazy"></button>`)}</div>` : ''}
        </div>
        <div class="buy">
          <p class="buy__meta">${[m.brand, m.type].filter(Boolean).join(' · ')}</p>
          <h1 class="buy__title">${m.model || m.title}</h1>
          ${m.colorway ? html`<p class="buy__color">${m.colorway}</p>` : ''}
          <p class="buy__price">${m.oldPrice ? html`<span class="price price--lg price--sale">${rub(m.price)}</span><s class="price-old price-old--lg">${rub(m.oldPrice)}</s><span class="chip chip--sale">−${m.discount}%</span>` : html`<span class="price price--lg">${m.priceMax > m.price && !firstFree ? 'от ' : ''}${rub(firstFree ? firstFree.price : m.price)}</span>`}
            ${m.inStock ? html`<span class="stockline is-in">${isExt ? 'В наличии' : html`В наличии: ${availSizes.length} ${plural(availSizes.length, 'размер', 'размера', 'размеров')}`}</span>` : html`<span class="stockline">Нет в наличии</span>`}</p>
          ${m.oldPrice && m.saleTo ? html`<p class="saleinfo">${icon('clock')} Скидка действует до ${m.saleTo.split('-').reverse().join('.')}</p>` : ''}
          <form class="buy__form" action="/cart/add" method="post" data-add-form>
            <input type="hidden" name="back" value="/p/${m.slug}">
            ${isExt ? html`<input type="radio" name="pid" value="${m.sizes[0].id}" ${m.inStock ? raw('checked') : raw('disabled')} hidden data-size-label="" data-left="${m.sizes[0].qty}">` : html`<div class="buy__sizes-head"><b>Размер${m.sizes.some((s) => s.size && !isNaN(parseFloat(s.size))) ? ' (EU)' : ''}</b><span class="muted" data-size-hint>Выберите размер</span></div>
            <div class="sizes sizes--pdp" role="radiogroup" aria-label="Размер">
              ${m.sizes.map((s) => html`<label class="size${s.qty > 0 ? '' : ' is-off'}" title="${s.qty > 0 ? (s.qty <= 2 ? 'Осталось ' + s.qty + ' шт.' : 'В наличии') : 'Нет в наличии'}">
                <input type="radio" name="pid" value="${s.id}" ${s.qty > 0 ? '' : raw('disabled')} data-size-label="${s.label}" data-left="${s.qty}" required><span>${s.label}</span></label>`)}
            </div>
            ${m.dept === 'shoes' ? html`<div class="buy__sizeguide">${sizeGuideButton()}</div>` : ''}`}
            <div class="buy__row">
              <button class="btn btn--lg btn--block" type="submit" ${m.inStock ? '' : raw('disabled')} data-add-btn>${m.inStock ? html`${icon('bag')} Добавить в корзину` : 'Нет в наличии'}</button>
              ${favBtn(m, favSlugs(req).includes(m.slug), 'fav fav--lg')}
            </div>
          </form>
          <ul class="perks">
            <li>${icon('truck')}<span><b>Доставка</b> от ${rub(minDelivery ? minDelivery.q.price : 0)}${ctx.freeFrom ? html`, бесплатно от ${rub(ctx.freeFrom)}` : ''}</span></li>
            ${isExt ? html`<li>${icon('box')}<span><b>Поставка партнёра</b>: менеджер подтвердит наличие и срок</span></li>
            <li>${icon('shield')}<span><b>Оригинал</b>, чек и документы при получении</span></li>` : html`<li>${icon('store')}<span><b>Самовывоз</b> и примерка в магазине</span></li>
            <li>${icon('shield')}<span><b>Оригинал</b>, проверяем каждую пару</span></li>`}
          </ul>
          <details class="acc" ${descr ? raw('open') : ''}><summary>Описание</summary><div class="acc__body">${descr ? descr.split(/\n{2,}/).map((p) => html`<p>${p}</p>`) : html`<p>${m.fullName}.${m.own ? (m.own.article ? ` Артикул: ${m.own.article}.` : '') : ` Артикул: ${m.key}.`}</p>`}</div></details>
          ${isExt ? '' : guideBlock({ brand: m.brand, dept: m.dept, sizes: m.sizes.filter((s) => s.qty > 0).map((s) => s.size) })}
          <details class="acc"><summary>Доставка и оплата</summary><div class="acc__body">
            ${d.methods.filter((x) => x.active).map((x) => html`<p><b>${x.title}</b>${x.eta ? ' · ' + x.eta : ''}${x.price ? ' · от ' + rub(x.price) : ' · бесплатно'}</p>`)}
            <p><a href="/delivery">Подробнее о доставке и возврате</a></p></div></details>
          <p class="muted buy__sku">${isExt ? `Поставщик: ${(partner.get && partner.get(m.ext.source) ? partner.get(m.ext.source).name : 'Sergeev Electronics')}` : m.own ? (m.own.article ? html`Артикул: ${m.own.article}` : '') : html`Артикул: ${m.key}`}</p>
        </div>
      </div>
      ${related.length ? html`<section class="block block--tight"><div class="block__head"><div><p class="eyebrow">Вам может понравиться</p><h2>Похожие модели</h2></div></div>
        <div class="grid">${related.map((x) => card(x))}</div></section>` : ''}
    </section>`;
    send(req, res, { title: m.title + (m.colorway ? ` «${m.colorway}»` : ''), body, bodyClass: 'page-pdp', canonical: `/p/${m.slug}`, og: m.cover ? { image: photoUrl(m.cover, 640) } : null, jsonLd,
      description: `${m.fullName}: ${rub(m.price)}${m.inStock ? ', в наличии' : ''}. Оригинал, доставка по России и самовывоз.` });
    } catch (e) { next(e); }
  });

  // ---------- Избранное: адреса моделей лежат в cookie fav, страница собирается на сервере ----------
  app.get('/favorites', shopCtx, (req, res) => {
    tracker.record(req, res, 'page', { path: '/favorites' });
    const list = favSlugs(req).map((x) => catalog.bySlug.get(x)).filter(Boolean);
    const body = html`
    <section class="wrap catalog favpage">
      <nav class="crumbs"><a href="/">Главная</a>${icon('chevron-right')}<span>Избранное</span></nav>
      <div class="catalog__head"><div><h1>Избранное</h1><p class="muted">${list.length ? countLabel(list.length) : 'Здесь появятся модели, отмеченные сердечком'}</p></div></div>
      ${list.length ? html`<div class="grid">${list.map((m) => card(m, { fav: true }))}</div>`
        : html`<div class="empty"><p>Нажмите ${icon('heart')} на карточке модели, чтобы не потерять её. Избранное хранится в этом браузере.</p>
          <p><a class="btn" href="/catalog?sort=popular">Перейти в каталог ${icon('arrow-right')}</a></p></div>`}
    </section>`;
    send(req, res, { title: 'Избранное', body, bodyClass: 'page-plain', noindex: true });
  });

  // ---------- Бренды: по алфавиту, с числом моделей в наличии ----------
  app.get('/brands', shopCtx, (req, res) => {
    tracker.record(req, res, 'page', { path: '/brands' });
    req.ctx.navActive = 'brands';
    const counts = new Map();
    const covers = new Map();
    for (const m of catalog.models) {
      if (!m.inStock || !m.brand) continue;
      counts.set(m.brand, (counts.get(m.brand) || 0) + 1);
      if (m.cover && (!covers.has(m.brand) || m.featured)) covers.set(m.brand, m.cover);
    }
    const all = [...counts].sort((x, y) => x[0].localeCompare(y[0], 'ru', { sensitivity: 'base' }));
    const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 8);
    const groups = new Map();
    for (const [b, n] of all) {
      const ch = /^[a-zа-яё]/i.test(b) ? b[0].toUpperCase() : '#';
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch).push([b, n]);
    }
    const body = html`
    <section class="wrap catalog brandspage">
      <nav class="crumbs"><a href="/">Главная</a>${icon('chevron-right')}<span>Бренды</span></nav>
      <div class="catalog__head"><div><h1>Бренды</h1><p class="muted">${all.length} ${plural(all.length, 'бренд', 'бренда', 'брендов')} в наличии</p></div></div>
      ${top.length ? html`<div class="brandtop">${top.map(([b, n]) => html`<a class="brandtop__item" href="/catalog?brand=${encodeURIComponent(b)}">
        ${covers.get(b) ? html`<img src="${photoUrl(covers.get(b), 360)}" alt="" width="360" height="360" loading="lazy">` : ''}
        <b>${b}</b><i>${n} ${plural(n, 'модель', 'модели', 'моделей')}</i></a>`)}</div>` : ''}
      <nav class="abc" aria-label="Буквы">${[...groups.keys()].map((ch) => html`<a href="#b-${ch === '#' ? 'num' : ch}">${ch}</a>`)}</nav>
      <div class="brandlist">${[...groups].map(([ch, list]) => html`<section class="brandlist__g" id="b-${ch === '#' ? 'num' : ch}"><h2>${ch}</h2>
        <ul>${list.map(([b, n]) => html`<li><a href="/catalog?brand=${encodeURIComponent(b)}">${b}<i>${n}</i></a></li>`)}</ul></section>`)}</div>
    </section>`;
    send(req, res, { title: 'Бренды', body, bodyClass: 'page-plain', canonical: '/brands', description: `Бренды в ${req.ctx.settings.shopName}: ${all.slice(0, 12).map(([b]) => b).join(', ')}.` });
  });

  // ---------- Контакты: телефон, почта, Telegram, соцсети, адрес и карта ----------
  app.get('/contacts', shopCtx, (req, res) => {
    tracker.record(req, res, 'page', { path: '/contacts' });
    const s = req.ctx.settings;
    const tel = String(s.phone || '').replace(/[^+\d]/g, '');
    const tg = telegramUrl(s.telegram);
    const socials = socialList(s);
    const body = html`
    <section class="wrap prose contacts">
      <nav class="crumbs"><a href="/">Главная</a>${icon('chevron-right')}<span>Контакты</span></nav>
      <h1>Контакты</h1>
      <div class="cards3">
        ${s.phone ? html`<a class="infocard" href="tel:${tel}"><div class="infocard__ic">${icon('phone')}</div><h3>Телефон</h3><p>${s.phone}</p></a>` : ''}
        ${tg ? html`<a class="infocard" href="${tg}" rel="noopener" target="_blank"><div class="infocard__ic">${icon('send')}</div><h3>Telegram</h3><p>Ответим в чате</p></a>` : ''}
        ${s.email ? html`<a class="infocard" href="mailto:${s.email}"><div class="infocard__ic">${icon('mail')}</div><h3>Почта</h3><p>${s.email}</p></a>` : ''}
        ${s.address ? html`<div class="infocard"><div class="infocard__ic">${icon('pin')}</div><h3>Адрес магазина</h3><p>${s.address}</p>${s.hours ? html`<p class="muted">${s.hours}</p>` : ''}</div>` : ''}
      </div>
      ${socials.length ? html`<h2>Мы в соцсетях</h2><ul class="socials">${socials.map((x) => html`<li><a href="${x.url}" rel="noopener" target="_blank">${icon(x.icon)}${x.title}</a></li>`)}</ul>` : ''}
    </section>
    ${mapBlock(req.ctx, { force: true })}`;
    send(req, res, { title: 'Контакты', body, bodyClass: 'page-plain page-contacts', canonical: '/contacts', description: `Контакты ${s.shopName}: ${[s.phone, s.address, s.hours].filter(Boolean).join(', ')}.` });
  });

  // ---------- Текстовые страницы из админки («О нас», соглашение, политика...) ----------
  // Таблицы размеров по брендам (в карточках обуви и одежды они же внутри товара)
  app.get('/razmery', shopCtx, (req, res) => {
    tracker.record(req, res, 'page', { path: '/razmery' });
    send(req, res, { title: 'Таблицы размеров', description: 'Таблицы размеров обуви Nike, adidas, New Balance и других брендов, мерки одежды и как измерить стопу.', body: guidePage(), bodyClass: 'page-plain', canonical: '/razmery' });
  });

  app.get('/info/:slug', shopCtx, async (req, res, next) => {
    try {
      const p = await pages.bySlug(String(req.params.slug).toLowerCase());
      // черновик видно только в админке (кнопка «Посмотреть»)
      const peek = app.locals.adminPeek && app.locals.adminPeek(req);
      if (!p || (!(p.published && p.body.trim()) && !peek)) return next();
      tracker.record(req, res, 'page', { path: `/info/${p.slug}` });
      const body = html`
      <section class="wrap prose infopage">
        <nav class="crumbs"><a href="/">Главная</a>${icon('chevron-right')}<span>${p.title}</span></nav>
        ${p.published ? '' : html`<p class="chip">Черновик: покупатели эту страницу не видят</p>`}
        <h1>${p.title}</h1>
        <div class="infopage__text">${renderText(p.body)}</div>
        <p class="muted infopage__date">Обновлено ${new Date(p.updated_at).toLocaleDateString('ru-RU', { timeZone: cfg.tz })}</p>
      </section>`;
      send(req, res, { title: p.title, body, bodyClass: 'page-plain', canonical: `/info/${p.slug}`, noindex: !p.published });
    } catch (e) { next(e); }
  });

  // ---------- Доставка и оплата ----------
  app.get('/delivery', shopCtx, (req, res) => {
    const d = req.ctx.deliveryData;
    tracker.record(req, res, 'page', { path: '/delivery' });
    const kindIcon = { pickup: 'store', courier: 'truck', tc: 'box' };
    const body = html`
    <section class="wrap prose">
      <nav class="crumbs"><a href="/">Главная</a>${icon('chevron-right')}<span>Доставка и оплата</span></nav>
      <h1>Доставка и оплата</h1>
      <div class="cards3">
        ${d.methods.filter((x) => x.active).map((x) => html`<article class="infocard">
          <div class="infocard__ic">${icon(kindIcon[x.kind])}</div>
          <h3>${x.title}</h3>
          <p>${x.description}</p>
          <dl>
            <dt>Срок</dt><dd>${x.eta || '-'}</dd>
            <dt>Стоимость</dt><dd>${x.price ? 'от ' + rub(x.price) : 'бесплатно'}${x.door_extra ? html` <span class="muted">(+${rub(x.door_extra)} до двери)</span>` : ''}</dd>
            ${x.free_from !== null ? html`<dt>Бесплатно</dt><dd>от ${rub(x.free_from)}</dd>` : ''}
            ${x.cities ? html`<dt>Города</dt><dd>${x.cities}</dd>` : ''}
          </dl>
        </article>`)}
      </div>
      <h2>Оплата</h2>
      <ul class="plain">
        ${Object.values(PAY_METHODS).map((p) => html`<li><b>${p.title}.</b> ${p.hint}.</li>`)}
      </ul>
      <p class="muted">При доставке транспортной компанией заказ оплачивается заранее.</p>
      <h2 id="return">Обмен и возврат</h2>
      <p>Вы можете отказаться от заказа в течение 7 дней после получения, если сохранены товарный вид, бирки и упаковка. Деньги возвращаем тем же способом, которым вы платили. Примерьте пару при самовывозе, если не уверены в размере.</p>
      <p>Если вам прислали не ту модель или размер, свяжитесь с нами: ${req.ctx.settings.phone}, ${req.ctx.settings.email}.</p>
    </section>`;
    send(req, res, { title: 'Доставка и оплата', body, bodyClass: 'page-plain', canonical: '/delivery' });
  });

  // ---------- JSON для поиска и подбора ----------
  app.get('/api/suggest', async (req, res, next) => {
    try {
      await catalog.ensure();
      const q = String(req.query.q || '').slice(0, 80);
      const r = catalog.suggest(q, 6);
      res.set('Cache-Control', 'no-store').json({
        total: r.total || 0,
        brands: (r.brands || []).map(([name, n]) => ({ name, n, url: `/catalog?brand=${encodeURIComponent(name)}&q=${encodeURIComponent(q)}` })),
        items: (r.items || []).map((m) => ({ title: m.title, sub: [m.type, m.colorway].filter(Boolean).join(' · '), price: rub(m.price), url: `/p/${m.slug}`, img: m.cover ? photoUrl(m.cover, 360) : '', out: !m.inStock })),
        url: '/catalog?q=' + encodeURIComponent(q),
      });
    } catch (e) { next(e); }
  });

  app.get('/api/count', async (req, res, next) => {
    try {
      await catalog.ensure();
      const r = catalog.search(req.query, { pageSize: 1 });
      res.set('Cache-Control', 'no-store').json({ count: r.total, label: countLabel(r.total) });
    } catch (e) { next(e); }
  });

  // ---------- sitemap ----------
  app.get('/sitemap.xml', async (req, res, next) => {
    try {
      await catalog.ensure();
      const base = cfg.publicUrl || `${req.protocol}://${req.get('host')}`;
      const urls = ['/', '/catalog', '/brands', '/contacts', '/delivery', '/razmery', ...(await pages.all()).filter((p) => p.published && p.body.trim()).map((p) => `/info/${p.slug}`), ...catalog.models.filter((m) => m.inStock).slice(0, 40000).map((m) => `/p/${m.slug}`)];
      res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        urls.map((u) => `<url><loc>${base}${encodeURI(u)}</loc></url>`).join('') + '</urlset>');
    } catch (e) { next(e); }
  });
};
