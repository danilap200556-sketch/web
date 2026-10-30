'use strict';
// «Витрина и каталог»: сезон на главной, тексты, показ моделей на сайте.
const { html } = require('../html');
const { icon } = require('../icons');
const { rub, num, plural, clampInt, str } = require('../util');
const { SEASONS, seasonOf, heroFor } = require('../seasons');
const { SEASON_ICON, photoUrl } = require('../shopviews');
const { norm } = require('../catalog');
const { pager } = require('./layout');

const PAGE = 20;
const REASON = { manual: 'Скрыта вручную', no_photo: 'Нет фото', no_price: 'Нет цены' };

module.exports = function mount({ db, cfg, auth, render, router, catalog, settings }) {
  router.get('/showcase', auth.require('showcase'), async (req, res, next) => {
    try {
      await catalog.ensure();
      const s = await settings.get();
      const auto = seasonOf(new Date(), cfg.tz);
      const mode = SEASONS[s.seasonMode] ? s.seasonMode : 'auto';
      const effective = mode === 'auto' ? auto : mode;

      const q = str(req.query.q, 60);
      const show = ['hidden', 'featured', 'nophoto', 'out'].includes(req.query.show) ? req.query.show : '';
      const page = clampInt(req.query.page, 1, 10000, 1);
      const tokens = norm(q).split(' ').filter(Boolean);
      let list = (catalog.allModels || []).filter((m) => tokens.every((t) => m.search.includes(t)));
      if (show === 'hidden') list = list.filter((m) => m.hidden);
      if (show === 'featured') list = list.filter((m) => m.featured || m.badge);
      if (show === 'nophoto') list = list.filter((m) => !m.photos.length);
      if (show === 'out') list = list.filter((m) => !m.inStock);
      list.sort((a, b) => Number(b.featured) - Number(a.featured) || b.createdAt - a.createdAt);
      const pages = Math.max(1, Math.ceil(list.length / PAGE));
      const pageList = list.slice((page - 1) * PAGE, page * PAGE);
      const st = catalog.stats();
      const back = `/admin/showcase?${new URLSearchParams({ ...(q ? { q } : {}), ...(show ? { show } : {}), ...(page > 1 ? { page } : {}) })}`;
      const keep = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ q, show, ...o })) if (v) u.set(k, v); return u.toString(); };

      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Сезон на главной странице</h2>
          <p class="muted">Сейчас на сайте: <b>${SEASONS[effective].title}</b>${mode === 'auto' ? ' (выбран автоматически по дате)' : ' (закреплён вручную)'}. От сезона зависят цвета сайта, заголовок и подборка «Выбор сезона».</p></div></header>
        <form method="post" action="/admin/showcase/season">${req.adminCsrf}
          <div class="seasons">
            ${[['auto', 'Автоматически', 'по календарю: сейчас ' + SEASONS[auto].title.toLowerCase(), 'clock'], ...Object.entries(SEASONS).map(([k, v]) => [k, v.title, 'тема «' + v.accent + '»', SEASON_ICON[k]])].map(([k, t, hint, ic]) => html`
              <label class="seasoncard seasoncard--${k}"><input type="radio" name="mode" value="${k}" ${mode === k ? 'checked' : ''}>
                <span class="seasoncard__in">${icon(ic)}<b>${t}</b><small>${hint}</small>${k !== 'auto' ? html`<a class="link" href="/?preview_season=${k}" target="_blank" rel="noopener">Предпросмотр</a>` : ''}</span></label>`)}
          </div>
          <details class="texts"><summary>Тексты главной по сезонам</summary>
            <div class="texts__grid">${Object.keys(SEASONS).map((k) => { const h = heroFor(k, s); const ov = (s.heroOverrides || {})[k] || {}; return html`
              <fieldset><legend>${SEASONS[k].title}</legend>
                <label class="field">Метка<input name="eyebrow_${k}" value="${ov.eyebrow || ''}" placeholder="${SEASONS[k].hero.eyebrow}" maxlength="40"></label>
                <label class="field">Заголовок<input name="title_${k}" value="${ov.title || ''}" placeholder="${SEASONS[k].hero.title}" maxlength="90"></label>
                <label class="field">Описание<textarea name="text_${k}" rows="3" placeholder="${SEASONS[k].hero.text}" maxlength="260">${ov.text || ''}</textarea></label>
                <small class="muted">Пусто - стандартный текст</small></fieldset>`; })}</div></details>
          <label class="check"><input type="checkbox" name="requirePhoto" ${s.requirePhoto ? 'checked' : ''}><span>Показывать только модели с фото <small class="muted">(фото подбираются в приложении «Склад»)</small></span></label>
          <label class="check"><input type="checkbox" name="electronicsTeaser" ${s.electronicsTeaser ? 'checked' : ''}><span>Плашка «Скоро электроника» на главной <small class="muted">(пропадёт сама, когда в базе появится электроника)</small></span></label>
          <button class="btn btn--primary" type="submit">Сохранить</button>
        </form>
      </section>

      <section class="card card--pad">
        <header class="card__h"><div><h2>Модели на сайте</h2>
          <p class="muted">На сайте <b>${num(st.inStock)}</b> из ${num(st.models + st.hidden)} ${plural(st.models + st.hidden, 'модели', 'моделей', 'моделей')} в наличии. Скрыто: <b>${num(st.hidden)}</b>. Товары, цены и остатки приходят из приложения «Склад» сами; здесь только то, что относится к витрине.</p></div></header>
        <form class="filters" method="get" action="/admin/showcase">
          <label class="search"><input type="search" name="q" value="${q}" placeholder="Название, бренд или артикул">${icon('search')}</label>
          <select name="show" data-autosubmit aria-label="Показать">${[['', 'Все модели'], ['featured', 'С ярлыком или закреплённые'], ['hidden', 'Скрытые'], ['nophoto', 'Без фото'], ['out', 'Нет в наличии']].map(([v, t]) => html`<option value="${v}" ${show === v ? 'selected' : ''}>${t}</option>`)}</select>
          <button class="btn" type="submit">Найти</button>
        </form>
        <p class="muted">Найдено: ${num(list.length)}</p>
        <div class="mlist">
          ${pageList.map((m) => html`<form class="mrow${m.hidden ? ' is-hidden' : ''}" method="post" action="/admin/showcase/model">${req.adminCsrf}
            <input type="hidden" name="key" value="${m.key}"><input type="hidden" name="back" value="${back}">
            <span class="mrow__img">${m.cover ? html`<img src="${photoUrl(m.cover, 360)}" alt="" width="56" height="56" loading="lazy">` : html`<span class="toplist__ph"></span>`}</span>
            <div class="mrow__t"><b>${m.title}${m.colorway ? ' «' + m.colorway + '»' : ''}</b>
              <small class="muted">${[m.type, 'арт. ' + m.key, rub(m.price), m.inStock ? m.qty + ' шт.' : 'нет в наличии'].filter(Boolean).join(' · ')}</small>
              ${m.hideReason ? html`<small class="why">${REASON[m.hideReason]}</small>` : ''}</div>
            <label class="check"><input type="checkbox" name="featured" ${m.featured ? 'checked' : ''}><span>Показывать первой</span></label>
            <label class="check"><input type="checkbox" name="hidden" ${m.hideReason === 'manual' ? 'checked' : ''}><span>Скрыть</span></label>
            <input class="badge-in" name="badge" value="${m.badge}" maxlength="24" placeholder="Ярлык, например: Хит" aria-label="Ярлык">
            <button class="btn btn--sm" type="submit">Сохранить</button>
          </form>`)}
        </div>
        ${pager('/admin/showcase?' + keep({}), page, pages)}
      </section>`;
      await render(req, res, 'showcase', { title: 'Витрина и каталог', body, wide: true });
    } catch (e) { next(e); }
  });

  router.post('/showcase/season', auth.require('showcase'), async (req, res, next) => {
    try {
      const mode = SEASONS[req.body.mode] ? req.body.mode : 'auto';
      const overrides = {};
      for (const k of Object.keys(SEASONS)) {
        const o = { eyebrow: str(req.body[`eyebrow_${k}`], 40), title: str(req.body[`title_${k}`], 90), text: str(req.body[`text_${k}`], 260) };
        if (o.eyebrow || o.title || o.text) overrides[k] = o;
      }
      await settings.set({ seasonMode: mode, heroOverrides: overrides, requirePhoto: req.body.requirePhoto === 'on', electronicsTeaser: req.body.electronicsTeaser === 'on' });
      catalog.invalidate();
      res.flash('ok', 'Витрина обновлена');
      res.redirect('/admin/showcase');
    } catch (e) { next(e); }
  });

  router.post('/showcase/model', auth.require('showcase'), async (req, res, next) => {
    try {
      const key = str(req.body.key, 100);
      const back = String(req.body.back || '');
      if (key) {
        await db.query(
          `INSERT INTO webshop.model_flags (model_key, hidden, featured, badge, updated_at) VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (model_key) DO UPDATE SET hidden = EXCLUDED.hidden, featured = EXCLUDED.featured, badge = EXCLUDED.badge, updated_at = NOW()`,
          [key, req.body.hidden === 'on', req.body.featured === 'on', str(req.body.badge, 24)]);
        catalog.invalidate();
        res.flash('ok', 'Сохранено');
      }
      res.redirect(back.startsWith('/admin/showcase') ? back : '/admin/showcase');
    } catch (e) { next(e); }
  });
};
