'use strict';
// Раздел «Электроника»: каталог партнёра (Sergeev Electronics) - состояние обхода, наценка, ручное обновление.
// Скрыть отдельный товар или закрепить его можно в «Витрина и каталог»: товары партнёра там в общем списке.
const { html } = require('../html');
const { num } = require('../util');

module.exports = function mount({ auth, render, fmt, router, settings, partner, catalog }) {
  router.get('/electronics', auth.require('electronics'), async (req, res, next) => {
    try {
      const st = await partner.status();
      const s = await settings.get();
      const l = st.listing;
      const chip = (cls, text) => html`<span class="chip ${cls}">${text}</span>`;
      const body = html`
      <section class="card card--pad">
        <header class="card__h"><div><h2>Каталог партнёра: Sergeev Electronics</h2>
          <p class="muted">Ассортимент, цены, наличие и фото электроники подтягиваются с сайта партнёра и показываются в разделе «Электроника». Заказы на такие товары приходят вам обычным порядком, а передать их партнёру нужно самим: в заказе они помечены.</p></div></header>
        <p>${st.enabled ? chip('chip--green', 'синхронизация включена') : chip('chip--gray', 'синхронизация выключена')}
          ${st.running === 'listing' ? chip('chip--blue', 'идёт обход каталога') : st.running === 'details' ? chip('chip--blue', 'идёт загрузка карточек') : ''}</p>
        <dl class="facts">
          <dt>Товаров в каталоге</dt><dd>${num(st.total)}, в наличии ${num(st.in_stock)}</dd>
          <dt>С описанием и крупными фото</dt><dd>${num(st.with_details)} из ${num(st.total)} (остальные догружаются в фоне)</dd>
          <dt>Последний обход каталога</dt><dd>${l && l.finishedAt ? html`${fmt.dateTime(l.finishedAt)}: страниц ${num(l.pages)}, товаров ${num(l.items)}` : 'ещё не было'}</dd>
          ${l && l.error ? html`<dt>Ошибка обхода</dt><dd class="warn">${l.error}</dd>` : ''}
          <dt>Источник</dt><dd><a href="${st.baseUrl}" target="_blank" rel="noopener">${st.baseUrl}</a></dd>
        </dl>
        ${st.enabled ? html`<form method="post" action="/admin/electronics/sync">${req.adminCsrf}<button class="btn" type="submit" ${st.running ? 'disabled' : ''}>Обновить каталог сейчас</button>
          <span class="muted">Обход занимает несколько минут: сайт партнёра опрашивается с паузами.</span></form>` : html`<p class="muted">Включение: на сервере в <code>.env</code> уберите <code>PARTNER_SYNC=off</code> (или задайте <code>PARTNER_SYNC=on</code>) и пересоздайте контейнер.</p>`}
      </section>
      <section class="card card--pad">
        <h2>Цены</h2>
        <p class="muted">Цена на сайте берётся у партнёра. Если вам нужна наценка, задайте её в процентах: она добавляется к цене партнёра и округляется вверх до 10 ₽. Скидка (зачёркнутая цена) тоже пересчитывается.</p>
        <form method="post" action="/admin/electronics/markup" class="mform__grid">${req.adminCsrf}
          <label class="field">Наценка к цене партнёра, %<input name="markupPct" inputmode="decimal" value="${(s.electronics || {}).markupPct || 0}" maxlength="5"></label>
          <label class="check field--wide"><input type="checkbox" name="showOldPrice" ${(s.electronics || {}).showOldPrice ? 'checked' : ''}><span>Показывать зачёркнутую цену партнёра как скидку <small class="muted">(у партнёра зачёркнутая цена стоит почти у каждого товара; включайте, только если уверены, что это настоящая скидка)</small></span></label>
          <div class="mform__foot"><button class="btn btn--primary" type="submit">Сохранить</button></div>
        </form>
      </section>`;
      await render(req, res, 'electronics', { title: 'Электроника', body });
    } catch (e) { next(e); }
  });

  router.post('/electronics/sync', auth.require('electronics'), async (req, res, next) => {
    try {
      res.flash(partner.syncNow() ? 'ok' : 'err', partner.enabled() ? 'Обход каталога запущен: товары появляются на сайте по мере загрузки' : 'Синхронизация выключена');
      res.redirect('/admin/electronics');
    } catch (e) { next(e); }
  });

  router.post('/electronics/markup', auth.require('electronics'), async (req, res, next) => {
    try {
      const v = parseFloat(String(req.body.markupPct || '0').replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 100) res.flash('err', 'Наценка: число от 0 до 100');
      else { await settings.set({ electronics: { markupPct: Math.round(v * 100) / 100, showOldPrice: req.body.showOldPrice === 'on' } }); catalog.invalidate(); res.flash('ok', 'Наценка сохранена'); }
      res.redirect('/admin/electronics');
    } catch (e) { next(e); }
  });
};
