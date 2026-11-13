'use strict';
// «Витрина и каталог»: сезон на главной, тексты, фон первого экрана (своё видео или фото), показ моделей на сайте.
const express = require('express');
const { html } = require('../html');
const { icon } = require('../icons');
const { rub, num, plural, clampInt, str } = require('../util');
const { SEASONS, seasonOf, heroFor } = require('../seasons');
const { SEASON_ICON, photoUrl } = require('../shopviews');
const { norm } = require('../catalog');
const { pager } = require('./layout');

const PAGE = 20;

// Состояние чтения цен сайта: если таблицу не создало приложение или нет прав, сайт работает на ценах склада
function priceNotice(catalog) {
  const s = catalog.sitePricesState;
  if (!s || s.status === 'ok') return s ? html`<p class="muted">Цены и скидки сайта (вкладка «Цены сайта» в приложении): задано для ${s.count} ${s.count % 10 === 1 && s.count % 100 !== 11 ? 'модели' : 'моделей'}; у остальных - цена склада.</p>` : '';
  const why = { missing: 'в базе нет таблицы site_prices: запустите новую версию приложения «Склад» один раз', denied: 'у пользователя сайта нет права читать site_prices: выполните grants.sql', error: 'не удалось прочитать таблицу site_prices (см. журнал сайта)' }[s.status];
  return html`<p class="hint">Цены сайта не подключены: ${why}. Пока на сайте цены склада.</p>`;
}
const REASON = { manual: 'Скрыта вручную', no_photo: 'Нет фото', no_price: 'Нет цены', note_only: 'Только размеры с пометками (без коробки, один кроссовок...)' };

module.exports = function mount({ db, cfg, auth, render, router, catalog, settings, heroMedia }) {
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

      const hm = s.heroMedia && s.heroMedia.id ? s.heroMedia : null;
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Фон первого экрана</h2>
          <p class="muted">Своё видео или фото на всю ширину главной, как у больших магазинов. Без файла там живой фон в цветах сезона.
          Видео: MP4 или WebM, до 60 МБ, лучше 10-20 секунд, без звука (оно всё равно играет беззвучно и по кругу). Фото: JPEG, PNG или WebP, горизонтальное, от 1920 px по ширине.
          Текст на главной лежит слева: удачнее кадры, где слева темно и спокойно.</p></div></header>
        <div class="heromedia">
          ${hm ? html`<div class="heromedia__now">${hm.kind === 'video'
            ? html`<video class="heromedia__preview" src="/media/hero/${hm.id}" muted loop playsinline controls preload="metadata"></video>`
            : html`<img class="heromedia__preview" src="/media/hero/${hm.id}" alt="Фон первого экрана">`}
            <p>Сейчас на главной: <b>${hm.kind === 'video' ? 'видео' : 'фото'}</b>, ${(hm.size / 1048576).toFixed(1).replace('.', ',')} МБ</p></div>`
            : html`<p class="heromedia__now muted">Сейчас на главной: живой фон в цветах сезона.</p>`}
          <form class="heromedia__form" action="/admin/showcase/hero-media" method="post" data-hero-upload data-csrf="${req.admin.csrf}">${req.adminCsrf}
            <label class="field">Новый файл<input type="file" name="file" accept="video/mp4,video/webm,image/jpeg,image/png,image/webp" required data-hero-file></label>
            <button class="btn btn--primary" type="submit">Загрузить</button>
            <progress class="heromedia__progress" max="100" value="0" hidden data-hero-progress></progress>
            <p class="heromedia__msg" role="status" data-hero-msg></p>
          </form>
          ${hm ? html`<form method="post" action="/admin/showcase/hero-media/remove">${req.adminCsrf}<button class="btn" type="submit">Убрать и вернуть живой фон</button></form>` : ''}
        </div>
      </section>

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
          <label class="check"><input type="checkbox" name="showNoteSizes" ${s.showNoteSizes ? 'checked' : ''}><span>Продавать размеры с пометками в артикуле как обычные <small class="muted">(например <code>_42(б/к)</code>, <code>_43 (1 кроссовок)</code>, ширина <code>(2E)</code>, <code>(Брак)</code>. Покупатель увидит только размер без слов, поэтому по умолчанию такие варианты не продаются: иначе под размером «42» можно получить один кроссовок или пару с браком. Ширина «D» считается обычной)</small></span></label>
          <label class="check"><input type="checkbox" name="requirePhoto" ${s.requirePhoto ? 'checked' : ''}><span>Показывать только модели с фото <small class="muted">(фото подбираются в приложении «Склад»)</small></span></label>
          <label class="check"><input type="checkbox" name="electronicsTeaser" ${s.electronicsTeaser ? 'checked' : ''}><span>Плашка «Скоро электроника» на главной <small class="muted">(пропадёт сама, когда в базе появится электроника)</small></span></label>
          <button class="btn btn--primary" type="submit">Сохранить</button>
        </form>
      </section>

      <section class="card card--pad">
        <header class="card__h"><div><h2>Модели на сайте</h2>
          ${priceNotice(catalog)}
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
              <small class="muted">${[m.type, 'арт. ' + m.key, m.oldPrice ? `${rub(m.price)} (было ${rub(m.oldPrice)}, −${m.discount}%)` : rub(m.price), m.priceSource === 'site' ? 'цена сайта' : 'цена склада', m.inStock ? m.qty + ' шт.' : 'нет в наличии'].filter(Boolean).join(' · ')}</small>
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
      await settings.set({ seasonMode: mode, heroOverrides: overrides, requirePhoto: req.body.requirePhoto === 'on', showNoteSizes: req.body.showNoteSizes === 'on', electronicsTeaser: req.body.electronicsTeaser === 'on' });
      catalog.invalidate();
      res.flash('ok', 'Витрина обновлена');
      res.redirect('/admin/showcase');
    } catch (e) { next(e); }
  });

  // Загрузка фона первого экрана. Файл приходит «как есть» (не формой): так видео в десятки мегабайт не нужно разбирать
  // на части. Токен csrf - в заголовке X-CSRF-Token, его проверяет auth.require.
  router.post('/showcase/hero-media',
    express.raw({ type: () => true, limit: '64mb' }),
    (req, res, next) => {
      req.heroUpload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const formToken = req.body && !Buffer.isBuffer(req.body) ? req.body._csrf : '';
      req.body = { _csrf: req.get('x-csrf-token') || formToken || '' };
      next();
    },
    auth.require('showcase'),
    async (req, res, next) => {
      try {
        const r = await heroMedia.save(req.heroUpload);
        if (r.error) return res.status(400).json({ error: r.error });
        res.flash('ok', r.kind === 'video' ? 'Видео загружено: оно уже на главной' : 'Фото загружено: оно уже на главной');
        res.json({ ok: true, id: r.id, kind: r.kind });
      } catch (e) { next(e); }
    });

  router.post('/showcase/hero-media/remove', auth.require('showcase'), async (req, res, next) => {
    try {
      await heroMedia.remove();
      res.flash('ok', 'Фон убран: на главной снова живой фон в цветах сезона');
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
