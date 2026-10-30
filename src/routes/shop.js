'use strict';
const { html, raw } = require('../html');
const { icon } = require('../icons');
const { rub, plural, num } = require('../util');
const { DEPARTMENTS } = require('../model');
const { SEASONS, heroFor, seasonPicks } = require('../seasons');
const { card, pagination, photoUrl, countLabel, priceBlock, SEASON_ICON } = require('../shopviews');
const { quote, PAY_METHODS } = require('../delivery');

const SIZES_QUICK = ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'];

module.exports = function mount(app, { catalog, tracker, cfg, media }, shopCtx, send) {
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

    const body = html`
    <section class="hero">
      <div class="wrap hero__in">
        <div class="hero__copy">
          <p class="chip chip--season">${icon(SEASON_ICON[season])} ${hero.eyebrow} ${new Date().getFullYear()}</p>
          <h1 class="hero__title">${hero.title}</h1>
          <p class="hero__text">${hero.text}</p>
          <form class="hero__search" action="/catalog" method="get" role="search">
            ${icon('search')}
            <input type="search" name="q" placeholder="Что ищете? Например, «new balance 9060»" autocomplete="off" aria-label="Поиск по магазину" data-search-input data-search-inline>
            <button class="btn" type="submit">Найти</button>
          </form>
          <div class="hero__quick">
            <span>Часто ищут:</span>
            ${brands.slice(0, 4).map(([b]) => html`<a href="/catalog?brand=${encodeURIComponent(b)}">${b}</a>`)}
          </div>
        </div>
        <div class="hero__stage" aria-hidden="${heroModels.length ? 'false' : 'true'}">
          <div class="stage__bg"></div>
          ${heroModels.map((m, i) => html`<a class="stage__item stage__item--${i + 1}" href="/p/${m.slug}" tabindex="${i ? '0' : '0'}">
            <img src="${photoUrl(m.cover, 640)}" alt="${m.title}" width="640" height="640" ${i === 0 ? raw('fetchpriority="high"') : raw('loading="lazy"')}>
            <span class="stage__tag"><b>${m.brand} ${m.model}</b><i>${rub(m.price)}</i></span>
          </a>`)}
        </div>
      </div>
    </section>

    <section class="usp">
      <div class="wrap usp__grid">
        <div class="usp__item">${icon('truck')}<div><b>Доставка по России</b><span>СДЭК, Boxberry, Почта, курьер</span></div></div>
        <div class="usp__item">${icon('store')}<div><b>Самовывоз с примеркой</b><span>Заберите сегодня</span></div></div>
        <div class="usp__item">${icon('shield')}<div><b>Только оригинал</b><span>Проверяем каждую пару</span></div></div>
        <div class="usp__item">${icon('return')}<div><b>Обмен и возврат</b><span>7 дней на решение</span></div></div>
      </div>
    </section>

    ${picks.length ? html`<section class="block">
      <div class="wrap">
        <div class="block__head">
          <div><p class="eyebrow">${icon(SEASON_ICON[season])} Выбор сезона</p><h2>${SEASONS[season].title}: что носим сейчас</h2></div>
          <a class="link" href="/catalog?sort=popular">Весь каталог ${icon('arrow-right')}</a>
        </div>
        <div class="grid grid--rail">${picks.map((m, i) => card(m, { priority: i < 4 }))}</div>
      </div>
    </section>` : ''}

    ${onSale.length >= 4 ? html`<section class="block">
      <div class="wrap">
        <div class="block__head"><div><p class="eyebrow">${icon('tag')} Цены снижены</p><h2>Сейчас со скидкой</h2></div><a class="link" href="/catalog?sale=1&amp;sort=discount">Все скидки ${icon('arrow-right')}</a></div>
        <div class="grid grid--rail">${onSale.map((m) => card(m))}</div>
      </div>
    </section>` : ''}

    <section class="block block--finder">
      <div class="wrap">
        <div class="finder" data-finder>
          <div class="finder__copy">
            <p class="eyebrow">Подбор пары</p>
            <h2>Выберите размер и тип,<br>остальное найдём</h2>
            <p>Покажем только то, что есть в вашем размере прямо сейчас.</p>
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
                ${SIZES_QUICK.map((s) => html`<label class="size"><input type="checkbox" name="size" value="${s}" data-finder-input><span>${s}</span></label>`)}
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
                  ${[8000, 12000, 16000, 24000].map((p) => html`<option value="${p}">${rub(p)}</option>`)}
                </select>
              </label>
            </fieldset>
            <button class="btn btn--lg btn--block" type="submit" data-finder-go>Показать <span data-finder-count>${countLabel(catalog.models.filter((m) => m.inStock && m.type === 'Кроссовки').length)}</span> ${icon('arrow-right')}</button>
          </form>
        </div>
      </div>
    </section>

    ${tiles.length ? html`<section class="block">
      <div class="wrap">
        <div class="block__head"><div><p class="eyebrow">Категории</p><h2>Что вы ищете</h2></div></div>
        <div class="tiles">
          ${tiles.map((t, i) => html`<a class="tile tile--${i + 1}" href="${t.href}">
            <img src="${photoUrl(t.cover, 640)}" alt="" width="640" height="640" loading="lazy">
            <span class="tile__t"><b>${t.title}</b><i>${t.count} ${plural(t.count, 'модель', 'модели', 'моделей')}</i></span>
            <span class="tile__go">${icon('arrow-up-right')}</span>
          </a>`)}
        </div>
      </div>
    </section>` : ''}

    ${brands.length ? html`<section class="block block--tight">
      <div class="wrap">
        <div class="brands">
          ${brands.map(([b, n]) => html`<a class="brands__item" href="/catalog?brand=${encodeURIComponent(b)}"><b>${b}</b><span>${n}</span></a>`)}
        </div>
      </div>
    </section>` : ''}

    ${newest.length ? html`<section class="block">
      <div class="wrap">
        <div class="block__head"><div><p class="eyebrow">Только что поступили</p><h2>Новинки</h2></div><a class="link" href="/catalog?sort=new">Все новинки ${icon('arrow-right')}</a></div>
        <div class="grid">${newest.map((m) => card(m))}</div>
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
            ${hidden('q', c.q)}${hidden('dept', c.dept)}${c.types.map((t) => hidden('type', t))}${c.brands.map((b) => hidden('brand', b))}${c.sizes.map((s) => hidden('size', s))}${hidden('min', c.min)}${hidden('max', c.max)}${!c.inStock ? hidden('all', '1') : ''}${c.sale ? hidden('sale', '1') : ''}
            <label><span class="sort__t">Сортировка</span>
              <select name="sort" aria-label="Сортировка">
                ${[['popular', 'Сначала популярные'], ['new', 'Новинки'], ['discount', 'Больше скидка'], ['price_asc', 'Подешевле'], ['price_desc', 'Подороже']].map(([v, t]) => html`<option value="${v}" ${c.sort === v ? raw('selected') : ''}>${t}</option>`)}
              </select>
            </label>
          </form>
        </div>
      </div>
      ${chips.length ? html`<div class="fchips">${chips}<a class="fchips__reset" href="/catalog${c.dept ? '?dept=' + c.dept : ''}">Сбросить всё</a></div>` : ''}
      <div class="catalog__cols">
        <aside class="filters" id="filters" data-filters>
          <div class="filters__top"><b>Фильтры</b><button class="iconbtn" type="button" data-filters-close aria-label="Закрыть">${icon('close')}</button></div>
          <form method="get" action="/catalog" data-autosubmit data-count-form>
            ${hidden('q', c.q)}${hidden('dept', c.dept)}${hidden('sort', c.sort !== 'popular' ? c.sort : '')}
            ${f.types.length > 1 ? html`<details class="fgroup" open><summary>Тип</summary>
              <div class="fgroup__body">${f.types.map(([t, n]) => html`<label class="check"><input type="checkbox" name="type" value="${t}" ${c.types.includes(t) ? raw('checked') : ''}><span>${t}</span><i>${n}</i></label>`)}</div></details>` : ''}
            ${f.sizes.length ? html`<details class="fgroup" open><summary>Размер</summary>
              <div class="fgroup__body sizes">${f.sizes.map(([s, n]) => html`<label class="size" title="${n} ${plural(n, 'модель', 'модели', 'моделей')}"><input type="checkbox" name="size" value="${s}" ${c.sizes.includes(s) ? raw('checked') : ''}><span>${s}</span></label>`)}</div></details>` : ''}
            ${brandsShown.length ? html`<details class="fgroup" open><summary>Бренд</summary>
              <div class="fgroup__body fgroup__body--scroll">${brandsShown.map(([b, n]) => html`<label class="check"><input type="checkbox" name="brand" value="${b}" ${c.brands.includes(b) ? raw('checked') : ''}><span>${b}</span><i>${n}</i></label>`)}</div></details>` : ''}
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
      noindex: !!c.q || c.page > 1 || c.sizes.length > 0 || !!c.min || !!c.max || c.sale, description: `${h1}: ${countLabel(r.total)} в магазине. Цены от ${rub(f.priceMin || 0)}, доставка по России и самовывоз.`,
    });
  });

  // Старые/короткие адреса отделов
  for (const d of Object.values(DEPARTMENTS)) app.get(`/${d.slug}`, (req, res) => res.redirect(301, `/catalog?dept=${d.slug}`));

  // ---------- Карточка модели ----------
  app.get('/p/:slug', shopCtx, (req, res) => {
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
    const jsonLd = {
      '@context': 'https://schema.org', '@type': 'Product', name: m.title, brand: m.brand ? { '@type': 'Brand', name: m.brand } : undefined,
      sku: m.key, image: photos.map((id) => `${ctx.baseUrl}${photoUrl(id, 1280)}`),
      description: m.description || `${m.fullName}. Оригинал, доставка по России.`,
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
            ${m.inStock ? html`<span class="stockline is-in">В наличии: ${availSizes.length} ${plural(availSizes.length, 'размер', 'размера', 'размеров')}</span>` : html`<span class="stockline">Нет в наличии</span>`}</p>
          ${m.oldPrice && m.saleTo ? html`<p class="saleinfo">${icon('clock')} Скидка действует до ${m.saleTo.split('-').reverse().join('.')}</p>` : ''}
          <form class="buy__form" action="/cart/add" method="post" data-add-form>
            <input type="hidden" name="back" value="/p/${m.slug}">
            <div class="buy__sizes-head"><b>Размер${m.sizes.some((s) => s.size && !isNaN(parseFloat(s.size))) ? ' (EU)' : ''}</b><span class="muted" data-size-hint>Выберите размер</span></div>
            <div class="sizes sizes--pdp" role="radiogroup" aria-label="Размер">
              ${m.sizes.map((s) => html`<label class="size${s.qty > 0 ? '' : ' is-off'}" title="${s.qty > 0 ? (s.qty <= 2 ? 'Осталось ' + s.qty + ' шт.' : 'В наличии') : 'Нет в наличии'}">
                <input type="radio" name="pid" value="${s.id}" ${s.qty > 0 ? '' : raw('disabled')} data-size-label="${s.label}" data-left="${s.qty}" required><span>${s.label}</span></label>`)}
            </div>
            <button class="btn btn--lg btn--block" type="submit" ${m.inStock ? '' : raw('disabled')} data-add-btn>${m.inStock ? html`${icon('bag')} Добавить в корзину` : 'Нет в наличии'}</button>
          </form>
          <ul class="perks">
            <li>${icon('truck')}<span><b>Доставка</b> от ${rub(minDelivery ? minDelivery.q.price : 0)}${ctx.freeFrom ? html`, бесплатно от ${rub(ctx.freeFrom)}` : ''}</span></li>
            <li>${icon('store')}<span><b>Самовывоз</b> и примерка в магазине</span></li>
            <li>${icon('shield')}<span><b>Оригинал</b>, проверяем каждую пару</span></li>
          </ul>
          <details class="acc" ${m.description ? raw('open') : ''}><summary>Описание</summary><div class="acc__body">${m.description ? m.description.split(/\n{2,}/).map((p) => html`<p>${p}</p>`) : html`<p>${m.fullName}. Артикул: ${m.key}.</p>`}</div></details>
          <details class="acc"><summary>Доставка и оплата</summary><div class="acc__body">
            ${d.methods.filter((x) => x.active).map((x) => html`<p><b>${x.title}</b>${x.eta ? ' · ' + x.eta : ''}${x.price ? ' · от ' + rub(x.price) : ' · бесплатно'}</p>`)}
            <p><a href="/delivery">Подробнее о доставке и возврате</a></p></div></details>
          <p class="muted buy__sku">Артикул: ${m.key}</p>
        </div>
      </div>
      ${related.length ? html`<section class="block block--tight"><div class="block__head"><div><p class="eyebrow">Вам может понравиться</p><h2>Похожие модели</h2></div></div>
        <div class="grid">${related.map((x) => card(x))}</div></section>` : ''}
    </section>`;
    send(req, res, { title: m.title + (m.colorway ? ` «${m.colorway}»` : ''), body, bodyClass: 'page-pdp', canonical: `/p/${m.slug}`, og: m.cover ? { image: photoUrl(m.cover, 640) } : null, jsonLd,
      description: `${m.fullName}: ${rub(m.price)}${m.inStock ? ', в наличии' : ''}. Оригинал, доставка по России и самовывоз.` });
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
      const urls = ['/', '/catalog', '/delivery', ...catalog.models.filter((m) => m.inStock).slice(0, 40000).map((m) => `/p/${m.slug}`)];
      res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        urls.map((u) => `<url><loc>${base}${encodeURI(u)}</loc></url>`).join('') + '</urlset>');
    } catch (e) { next(e); }
  });
};
