'use strict';
// «Страницы»: тексты магазина для подвала - «О нас», «Пользовательское соглашение», «Политика конфиденциальности», FAQ и свои.
const { html } = require('../html');
const { icon } = require('../icons');
const { PRESETS } = require('../pages');

module.exports = function mount({ auth, render, router, pages, fmt }) {
  const HELP = html`<p class="muted">Как оформлять текст: пустая строка - новый абзац; <code>## Заголовок</code>; строка с <code>- </code> в начале - пункт списка;
    <code>**жирный**</code>; ссылка - <code>[текст](https://адрес)</code> или <code>[текст](/delivery)</code>.</p>`;

  router.get('/pages', auth.require('pages'), async (req, res, next) => {
    try {
      const list = await pages.all();
      const have = new Set(list.map((p) => p.slug));
      const missing = PRESETS.filter((p) => !have.has(p.slug));
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Страницы магазина</h2>
          <p class="muted">Опубликованные страницы с галочкой «В подвале» стоят в колонке «Информация». «Пользовательское соглашение» (адрес <code>terms</code>)
          и «Политика конфиденциальности» (<code>privacy</code>) показываются ещё и в нижней строке подвала. Юридические тексты проверьте с юристом.</p></div>
          <a class="btn btn--primary" href="/admin/pages/new">${icon('plus')} Новая страница</a></header>
        ${list.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>Страница</th><th>Адрес</th><th>Состояние</th><th>Обновлена</th></tr></thead><tbody>
          ${list.map((p) => html`<tr data-href="/admin/pages/${p.id}">
            <td><a href="/admin/pages/${p.id}"><b>${p.title}</b></a></td>
            <td><code>/info/${p.slug}</code></td>
            <td>${p.published && p.body.trim() ? html`<span class="chip chip--green">На сайте${p.in_footer ? ', в подвале' : ''}</span>` : html`<span class="chip chip--gray">${p.body.trim() ? 'Черновик' : 'Пустая'}</span>`}</td>
            <td>${fmt.dateTime(p.updated_at)}</td>
          </tr>`)}
        </tbody></table></div>` : html`<p class="muted">Страниц пока нет.</p>`}
        ${missing.length ? html`<div class="presets"><p class="muted">Быстро создать черновик:</p>
          ${missing.map((p) => html`<form method="post" action="/admin/pages/preset">${req.adminCsrf}<input type="hidden" name="slug" value="${p.slug}"><button class="btn" type="submit">${p.title}</button></form>`)}</div>` : ''}
      </section>`;
      await render(req, res, 'pages', { title: 'Страницы', body });
    } catch (e) { next(e); }
  });

  router.post('/pages/preset', auth.require('pages'), async (req, res, next) => {
    try {
      const p = PRESETS.find((x) => x.slug === req.body.slug);
      if (!p) return res.redirect('/admin/pages');
      const r = await pages.save(0, { slug: p.slug, title: p.title, body: '', published: false, in_footer: true, sort: p.sort });
      if (r.error) { res.flash('err', r.error); return res.redirect('/admin/pages'); }
      res.flash('ok', 'Черновик создан: впишите текст и отметьте «Опубликовать»');
      res.redirect(`/admin/pages/${r.id}`);
    } catch (e) { next(e); }
  });

  const form = (req, p) => html`
    <section class="card card--pad">
      <form method="post" action="/admin/pages/${p.id || 'new'}" class="mform__grid">${req.adminCsrf}
        <label class="field field--wide">Заголовок<input name="title" value="${p.title || ''}" maxlength="120" required></label>
        <label class="field">Адрес страницы<input name="slug" value="${p.slug || ''}" maxlength="60" required pattern="[a-z0-9][a-z0-9\-]*" title="латиница, цифры и дефис"></label>
        <label class="field">Порядок в подвале<input name="sort" type="number" min="0" max="9999" value="${p.sort ?? 100}"></label>
        <label class="check"><input type="checkbox" name="published" ${p.published ? 'checked' : ''}><span>Опубликовать</span></label>
        <label class="check"><input type="checkbox" name="in_footer" ${p.in_footer !== false ? 'checked' : ''}><span>В подвале</span></label>
        <label class="field field--wide">Текст<textarea name="body" rows="22" maxlength="60000" class="pagetext">${p.body || ''}</textarea></label>
        <div class="field--wide">${HELP}</div>
        <div class="mform__foot">
          <button class="btn btn--primary" type="submit">Сохранить</button>
          ${p.id ? html`<a class="btn" href="/info/${p.slug}" target="_blank">${icon('eye')} Посмотреть</a>` : ''}
        </div>
      </form>
      ${p.id ? html`<form method="post" action="/admin/pages/${p.id}/delete" class="pagedel">${req.adminCsrf}<button class="btn" type="submit">Удалить страницу</button></form>` : ''}
    </section>`;

  router.get('/pages/new', auth.require('pages'), async (req, res, next) => {
    try { await render(req, res, 'pages', { title: 'Новая страница', body: form(req, { in_footer: true, sort: 100 }) }); } catch (e) { next(e); }
  });

  router.get('/pages/:id', auth.require('pages'), async (req, res, next) => {
    try {
      if (!/^\d{1,9}$/.test(req.params.id)) return res.redirect('/admin/pages');
      const p = (await pages.all()).find((x) => x.id === Number(req.params.id));
      if (!p) return res.redirect('/admin/pages');
      await render(req, res, 'pages', { title: p.title, body: form(req, p) });
    } catch (e) { next(e); }
  });

  router.post('/pages/:id', auth.require('pages'), async (req, res, next) => {
    try {
      if (req.params.id !== 'new' && !/^\d{1,9}$/.test(req.params.id)) return res.redirect('/admin/pages');
      const id = req.params.id === 'new' ? 0 : Number(req.params.id);
      const b = req.body;
      const r = await pages.save(id, { slug: b.slug, title: b.title, body: b.body, published: b.published === 'on', in_footer: b.in_footer === 'on', sort: b.sort });
      if (r.error) {
        res.flash('err', r.error);
        return res.redirect(id ? `/admin/pages/${id}` : '/admin/pages/new');
      }
      res.flash('ok', b.published === 'on' && String(b.body || '').trim() ? 'Сохранено: страница на сайте' : 'Сохранено');
      res.redirect(`/admin/pages/${r.id}`);
    } catch (e) { next(e); }
  });

  router.post('/pages/:id/delete', auth.require('pages'), async (req, res, next) => {
    try {
      if (/^\d{1,9}$/.test(req.params.id)) await pages.remove(Number(req.params.id));
      res.flash('ok', 'Страница удалена');
      res.redirect('/admin/pages');
    } catch (e) { next(e); }
  });

};
