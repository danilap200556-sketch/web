'use strict';
// Раздел «Электроника»: каталоги источников (Sergeev Electronics, bazaplay.ru) - состояние обхода, наценка, ручное обновление.
// Скрыть отдельный товар или закрепить его можно в «Витрина и каталог»: товары партнёра там в общем списке.
const { html } = require('../html');
const { num, rub, str } = require('../util');
const { priceOf, extPhoto, detectBrand } = require('../ext');
const { photoUrl } = require('../shopviews');
const { pager } = require('./layout');
const { can } = require('./auth');

const PAGE = 50;
const MAX_PRICE = 100_000_000;
const FLT = { all: 'Все', manual: 'С ручными ценами', stock: 'В наличии', out: 'Нет в наличии' };

// Число из поля формы: пусто - не задано (null), «12 345,5» - 12345.5; иначе ошибка
function parseNum(v) {
  const t = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: true };
  return { value: Number(t) };
}
const eq = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b));
const numCsv = (v) => (v === null || v === undefined || v === '' ? '' : String(Number(v)).replace('.', ','));
const csvCell = (v) => { const t = String(v ?? ''); return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

// Разбор вставки из Excel или файла CSV: разделитель - табуляция, «;» или «,»; кавычки поддерживаются
function parseTable(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const head = lines.find((l) => l.trim()) || '';
  const sep = head.includes('\t') ? '\t' : head.includes(';') ? ';' : ',';
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  return lines.map((l, i) => ({ n: i + 1, cells: l.trim() ? split(l) : null })).filter((r) => r.cells);
}
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');

module.exports = function mount({ db, auth, render, fmt, router, settings, partner, catalog }) {
  const globalPct = async () => Number(((await settings.get()).electronics || {}).markupPct) || 0;

  // ---------- Таблица цен ----------
  async function pricesPage(req, res, { posted = null, errors = [], status = 200 } = {}) {
    const src = { ...req.query, ...(req.method === 'POST' ? req.body : {}) };
    const q = str(src.q, 60);
    const flt = FLT[src.flt] ? src.flt : 'all';
    const page = Math.max(1, parseInt(src.page, 10) || 1);
    const params = [partner.sources];
    const where = ['e.source = ANY($1::text[])', "e.seen_at > NOW() - INTERVAL '3 days'", '(e.price > 0 OR p.manual_price > 0)'];
    if (q) { params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(e.title ILIKE $${params.length} OR e.brand ILIKE $${params.length} OR e.path ILIKE $${params.length})`); }
    if (flt === 'manual') where.push('(p.manual_price IS NOT NULL OR p.buy_price IS NOT NULL OR p.markup_pct IS NOT NULL)');
    if (flt === 'stock') where.push('e.in_stock');
    if (flt === 'out') where.push('NOT e.in_stock');
    const from = `FROM webshop.ext_products e LEFT JOIN webshop.ext_prices p ON p.ext_id = e.id WHERE ${where.join(' AND ')}`;
    const [rows, cnt] = await Promise.all([
      db.query(`SELECT e.id, e.source, e.title, e.brand, e.section, e.price, e.in_stock, e.images, p.buy_price, p.markup_pct, p.manual_price ${from} ORDER BY e.brand, e.title, e.id LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, params),
      db.query(`SELECT COUNT(*)::int AS n ${from}`, params),
    ]);
    const g = await globalPct();
    const pages = Math.max(1, Math.ceil(cnt.rows[0].n / PAGE));
    const keep = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ q, flt: flt === 'all' ? '' : flt, ...o })) if (v) u.set(k, v); return u.toString(); };
    const val = (r, key, field) => (posted ? (posted[`${key}_${r.id}`] ?? '') : (r[field] === null || r[field] === undefined ? '' : Number(r[field])));
    const body = html`
      ${errors.length ? html`<div class="flash flash--err" role="alert"><b>Ничего не сохранено:</b><ul>${errors.slice(0, 12).map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <section class="card card--pad">
        <p class="muted">Цена на сайте = <b>ручная цена</b>, если она задана; иначе <b>закупка</b> (вручную или цена партнёра) плюс <b>наценка</b> товара (если пусто - общая ${g}% из раздела «Электроника»),
          округление вверх до 10 ₽. Пустое поле - значение не задано. Закупочные цены видит только владелец.</p>
        <form class="filters" method="get" action="/admin/electronics/prices">
          <label class="search"><input type="search" name="q" value="${q}" placeholder="Название, бренд или адрес у партнёра"></label>
          <select name="flt" data-autosubmit aria-label="Фильтр">${Object.entries(FLT).map(([k, t]) => html`<option value="${k}" ${flt === k ? 'selected' : ''}>${t}</option>`)}</select>
          <button class="btn" type="submit">Найти</button>
          <a class="btn btn--ghost" href="/admin/electronics/prices.csv">Выгрузить в Excel (CSV)</a>
        </form>
        <p class="muted">Найдено: <b>${num(cnt.rows[0].n)}</b>. Правьте поля и нажмите «Сохранить» внизу: сохраняются все строки этой страницы.</p>
      </section>
      <form method="post" action="/admin/electronics/prices" class="card">${req.adminCsrf}
        <input type="hidden" name="ids" value="${rows.rows.map((r) => r.id).join(',')}">
        <input type="hidden" name="q" value="${q}"><input type="hidden" name="flt" value="${flt === 'all' ? '' : flt}"><input type="hidden" name="page" value="${page}">
        ${rows.rows.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>Товар</th><th class="num">Закупка партнёра</th><th>Закупка вручную</th><th>Наценка, %</th><th class="num">Цена на сайте</th><th>Ручная цена</th></tr></thead><tbody>
          ${rows.rows.map((r) => { const brand = r.brand || detectBrand(r.title, r.section); const site = priceOf(r, g); return html`<tr class="${r.in_stock ? '' : 'is-off'}">
            <td><div class="prod">${Array.isArray(r.images) && r.images.length ? html`<img src="${photoUrl(extPhoto(r.id, 0), 360)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="toplist__ph"></span>`}
              <div><b>${r.title}</b><small class="muted">${[brand, `№ ${r.id}`, partner.list.length > 1 ? (partner.get(r.source) || {}).name : '', r.in_stock ? '' : 'нет в наличии'].filter(Boolean).join(' · ')}</small></div></div></td>
            <td class="num">${rub(r.price)}</td>
            <td><input class="pricein" name="buy_${r.id}" value="${val(r, 'buy', 'buy_price')}" inputmode="decimal" placeholder="как у партнёра" aria-label="Закупка вручную"></td>
            <td><input class="pricein pricein--s" name="mk_${r.id}" value="${val(r, 'mk', 'markup_pct')}" inputmode="decimal" placeholder="${g}" aria-label="Наценка, процентов"></td>
            <td class="num"><b>${rub(site)}</b></td>
            <td><input class="pricein" name="man_${r.id}" value="${val(r, 'man', 'manual_price')}" inputmode="decimal" placeholder="авто" aria-label="Ручная цена"></td></tr>`; })}</tbody></table></div>
          ${pager('/admin/electronics/prices?' + keep({ page: '' }), page, pages)}
          <div class="mform__foot"><button class="btn btn--primary" type="submit">Сохранить цены</button></div>` : html`<p class="empty-note">Товаров по этим условиям нет.</p>`}
      </form>
      <section class="card card--pad"><h2>Загрузить из Excel</h2>
        <p class="muted">Выгрузите таблицу (кнопка выше), поправьте колонки «Закупка вручную», «Наценка, %», «Ручная цена» и вставьте сюда выделенные в Excel ячейки (или текст CSV) вместе со строкой заголовка. Нужна колонка <code>id</code>; меняются только колонки, которые есть во вставке; пустая ячейка снимает значение.</p>
        <form method="post" action="/admin/electronics/prices/import">${req.adminCsrf}
          <label class="field field--wide"><span class="sr">Таблица</span><textarea name="data" rows="6" placeholder="id;Ручная цена&#10;123;99990"></textarea></label>
          <button class="btn" type="submit">Загрузить цены</button></form>
      </section>`;
    await render(req, res, 'electronics', { title: 'Таблица цен на электронику', body, wide: true, actions: html`<a class="btn btn--ghost btn--sm" href="/admin/electronics">К разделу «Электроника»</a>` }, status);
  }

  router.get('/electronics/prices', auth.require('eprices'), async (req, res, next) => { try { await pricesPage(req, res); } catch (e) { next(e); } });

  router.post('/electronics/prices', auth.require('eprices'), async (req, res, next) => {
    try {
      const ids = String(req.body.ids || '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
      const cur = new Map((await db.query(
        'SELECT e.id, e.title, p.buy_price, p.markup_pct, p.manual_price FROM webshop.ext_products e LEFT JOIN webshop.ext_prices p ON p.ext_id = e.id WHERE e.id = ANY($1) AND e.source = ANY($2::text[])',
        [ids, partner.sources])).rows.map((r) => [r.id, r]));
      const errors = [];
      const changes = [];
      for (const id of ids) {
        const c = cur.get(id);
        if (!c) continue;
        const b = parseNum(req.body[`buy_${id}`]);
        const m = parseNum(req.body[`mk_${id}`]);
        const p = parseNum(req.body[`man_${id}`]);
        const name = String(c.title).slice(0, 48);
        let bad = false;
        if (b.error || (b.value !== null && b.value > MAX_PRICE)) { errors.push(`${name}: Закупка: неверное число`); bad = true; }
        if (m.error || (m.value !== null && m.value > 300)) { errors.push(`${name}: Наценка: число от 0 до 300`); bad = true; }
        if (p.error || (p.value !== null && p.value > MAX_PRICE)) { errors.push(`${name}: Ручная цена: неверное число`); bad = true; }
        if (!bad && !(eq(c.buy_price, b.value) && eq(c.markup_pct, m.value) && eq(c.manual_price, p.value))) changes.push({ id, b: b.value, m: m.value, p: p.value });
      }
      if (errors.length) return pricesPage(req, res, { posted: req.body, errors, status: 422 });
      await applyChanges(changes, req.admin.user.name);
      res.flash('ok', changes.length ? `Сохранено товаров: ${changes.length}` : 'Изменений нет');
      const back = new URLSearchParams();
      for (const k of ['q', 'flt', 'page']) if (req.body[k]) back.set(k, String(req.body[k]).slice(0, 60));
      res.redirect(`/admin/electronics/prices${back.toString() ? '?' + back : ''}`);
    } catch (e) { next(e); }
  });

  // Все три поля пусты - строка не нужна; иначе вставка или обновление
  async function applyChanges(changes, who) {
    if (!changes.length) return;
    await db.tx(async (c) => {
      for (const x of changes) {
        if (x.b === null && x.m === null && x.p === null) { await c.query('DELETE FROM webshop.ext_prices WHERE ext_id = $1', [x.id]); continue; }
        await c.query(
          `INSERT INTO webshop.ext_prices (ext_id, buy_price, markup_pct, manual_price, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (ext_id) DO UPDATE SET buy_price = EXCLUDED.buy_price, markup_pct = EXCLUDED.markup_pct, manual_price = EXCLUDED.manual_price, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [x.id, x.b, x.m, x.p, String(who || '').slice(0, 60)]);
      }
    });
    catalog.invalidate();
  }

  router.get('/electronics/prices.csv', auth.require('eprices'), async (req, res, next) => {
    try {
      const g = await globalPct();
      const { rows } = await db.query(
        `SELECT e.id, e.title, e.brand, e.section, e.price, e.in_stock, p.buy_price, p.markup_pct, p.manual_price
           FROM webshop.ext_products e LEFT JOIN webshop.ext_prices p ON p.ext_id = e.id
          WHERE e.source = ANY($1::text[]) AND e.seen_at > NOW() - INTERVAL '3 days' AND (e.price > 0 OR p.manual_price > 0) ORDER BY e.brand, e.title, e.id`, [partner.sources]);
      const head = ['id', 'Название', 'Бренд', 'Закупка партнёра', 'Закупка вручную', 'Наценка, %', 'Ручная цена', 'Цена на сайте', 'В наличии'];
      const lines = rows.map((r) => [r.id, r.title, r.brand || detectBrand(r.title, r.section), numCsv(r.price), numCsv(r.buy_price), numCsv(r.markup_pct), numCsv(r.manual_price), priceOf(r, g), r.in_stock ? 'да' : 'нет'].map(csvCell).join(';'));
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="elektronika-ceny.csv"', 'Cache-Control': 'no-store' });
      res.send('﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n');
    } catch (e) { next(e); }
  });

  router.post('/electronics/prices/import', auth.require('eprices'), async (req, res, next) => {
    try {
      const rows = parseTable(String(req.body.data || '').slice(0, 2_000_000));
      const flash = (type, text) => { res.flash(type, text); res.redirect('/admin/electronics/prices'); };
      if (!rows.length) return flash('err', 'Вставьте таблицу: первой строкой заголовки, нужна колонка id');
      const head = rows[0].cells.map(norm);
      const find = (...keys) => head.findIndex((h) => keys.some((k) => h === k || h.startsWith(k)));
      const col = { id: head.findIndex((h) => h === 'id' || h === 'номер'), buy: find('закупкавручную', 'buy'), mk: find('наценка', 'markup'), man: find('ручнаяцена', 'manual') };
      if (col.id < 0) return flash('err', 'Нужна колонка id (номер товара из выгрузки)');
      if (col.buy < 0 && col.mk < 0 && col.man < 0) return flash('err', 'Во вставке нет колонок для изменения: «Закупка вручную», «Наценка, %» или «Ручная цена»');
      const ids = rows.slice(1).map((r) => parseInt(r.cells[col.id], 10)).filter((x) => Number.isInteger(x) && x > 0);
      const cur = new Map((await db.query(
        'SELECT e.id, p.buy_price, p.markup_pct, p.manual_price FROM webshop.ext_products e LEFT JOIN webshop.ext_prices p ON p.ext_id = e.id WHERE e.id = ANY($1) AND e.source = ANY($2::text[])',
        [ids, partner.sources])).rows.map((r) => [r.id, r]));
      const errors = [];
      const changes = [];
      let ok = 0;
      for (const r of rows.slice(1)) {
        const raw = r.cells[col.id];
        const id = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
        if (!Number.isInteger(id)) { errors.push(`строка ${r.n}: неверный номер`); continue; }
        const c = cur.get(id);
        if (!c) { errors.push(`строка ${r.n}: товара с номером ${id} нет`); continue; }
        const keepOld = (v) => ({ value: v === null || v === undefined ? null : Number(v) });
        const b = col.buy >= 0 ? parseNum(r.cells[col.buy]) : keepOld(c.buy_price);
        const m = col.mk >= 0 ? parseNum(r.cells[col.mk]) : keepOld(c.markup_pct);
        const p = col.man >= 0 ? parseNum(r.cells[col.man]) : keepOld(c.manual_price);
        if (b.error || m.error || p.error || (m.value !== null && m.value > 300) || [b.value, p.value].some((v) => v !== null && v > MAX_PRICE)) { errors.push(`строка ${r.n}: неверное число`); continue; }
        ok++;
        if (!(eq(c.buy_price, b.value) && eq(c.markup_pct, m.value) && eq(c.manual_price, p.value))) changes.push({ id, b: b.value, m: m.value, p: p.value });
        c.buy_price = b.value; c.markup_pct = m.value; c.manual_price = p.value;   // номер повторился: последняя строка главнее
      }
      await applyChanges(changes, req.admin.user.name);
      flash(errors.length ? 'err' : 'ok', `Обновлено товаров: ${ok}.${errors.length ? ' Не принято: ' + errors.slice(0, 8).join('; ') + (errors.length > 8 ? ` и ещё ${errors.length - 8}` : '') : ''}`);
    } catch (e) { next(e); }
  });

  router.get('/electronics', auth.require('electronics'), async (req, res, next) => {
    try {
      const sts = await Promise.all(partner.list.map((p) => p.status()));
      const s = await settings.get();
      const chip = (cls, text) => html`<span class="chip ${cls}">${text}</span>`;
      const card = (st) => {
        const l = st.listing;
        return html`<section class="card card--pad">
        <header class="card__h"><div><h2>Каталог: ${st.name}</h2>
          <p class="muted">Ассортимент, цены, наличие и фото электроники подтягиваются с сайта поставщика и показываются в разделе «Электроника». Заказы на такие товары приходят вам обычным порядком, а передать их поставщику нужно самим: в заказе они помечены.</p></div></header>
        <p>${st.enabled ? chip('chip--green', 'синхронизация включена') : chip('chip--gray', 'синхронизация выключена')}
          ${st.running === 'listing' ? chip('chip--blue', 'идёт обход каталога') : st.running === 'details' ? chip('chip--blue', 'идёт загрузка карточек') : ''}</p>
        <dl class="facts">
          <dt>Товаров в каталоге</dt><dd>${num(st.total)}, в наличии ${num(st.in_stock)}</dd>
          ${st.bySitemap && st.found > st.total ? html`<dt>Найдено адресов на сайте</dt><dd>${num(st.found)} (цены и фото загружаются из карточек порциями: за минуту примерно 12 товаров; часть адресов - разделы и снятые с продажи товары, их на сайте не будет)</dd>` : ''}
          <dt>С описанием и крупными фото</dt><dd>${num(st.with_details)} из ${num(st.total)} (остальные догружаются в фоне)</dd>
          <dt>Последний обход каталога</dt><dd>${l && l.finishedAt ? html`${fmt.dateTime(l.finishedAt)}: ${st.bySitemap ? `адресов ${num(l.items)}` : `страниц ${num(l.pages)}, товаров ${num(l.items)}`}` : 'ещё не было'}</dd>
          ${l && l.error ? html`<dt>Ошибка обхода</dt><dd class="warn">${l.error}</dd>` : ''}
          <dt>Источник</dt><dd><a href="${st.baseUrl}" target="_blank" rel="noopener">${st.baseUrl}</a></dd>
        </dl>
        ${st.enabled ? html`<form method="post" action="/admin/electronics/sync">${req.adminCsrf}<input type="hidden" name="source" value="${st.source}"><button class="btn" type="submit" ${st.running ? 'disabled' : ''}>Обновить каталог сейчас</button>
          <span class="muted">Сайт поставщика опрашивается с паузами, поэтому полная загрузка занимает от нескольких минут до нескольких часов.</span></form>` : html`<p class="muted">Включение: на сервере в <code>.env</code> уберите <code>${st.flag}=off</code> (или задайте <code>${st.flag}=on</code>) и пересоздайте контейнер.</p>`}
      </section>`;
      };
      const body = html`
      ${sts.map(card)}
      <section class="card card--pad">
        <h2>Цены</h2>
        ${can(req.admin.user.role, 'eprices') ? html`<p><a class="btn btn--primary" href="/admin/electronics/prices">Таблица цен: закупка, наценка, ручная цена</a> <span class="muted">Правьте цены каждого товара вручную, выгружайте и загружайте таблицу из Excel.</span></p>` : ''}
        <p class="muted">Цена на сайте берётся у поставщика. Если вам нужна наценка, задайте её в процентах: она добавляется к цене поставщика и округляется вверх до 10 ₽. Скидка (зачёркнутая цена) тоже пересчитывается. Наценка одна на все источники; для отдельного товара её можно задать в таблице цен.</p>
        <form method="post" action="/admin/electronics/markup" class="mform__grid">${req.adminCsrf}
          <label class="field">Наценка к цене поставщика, %<input name="markupPct" inputmode="decimal" value="${(s.electronics || {}).markupPct || 0}" maxlength="5"></label>
          <label class="check field--wide"><input type="checkbox" name="showOldPrice" ${(s.electronics || {}).showOldPrice ? 'checked' : ''}><span>Показывать зачёркнутую цену поставщика как скидку <small class="muted">(у поставщиков зачёркнутая цена стоит почти у каждого товара; включайте, только если уверены, что это настоящая скидка)</small></span></label>
          <div class="mform__foot"><button class="btn btn--primary" type="submit">Сохранить</button></div>
        </form>
      </section>`;
      await render(req, res, 'electronics', { title: 'Электроника', body });
    } catch (e) { next(e); }
  });

  router.post('/electronics/sync', auth.require('electronics'), async (req, res, next) => {
    try {
      const only = partner.sources.includes(req.body.source) ? req.body.source : '';
      const started = partner.syncNow(only);
      const svc = only ? partner.get(only) : partner;
      res.flash(started ? 'ok' : 'err', started ? 'Обход каталога запущен: товары появляются на сайте по мере загрузки' : svc.enabled() ? 'Обход уже идёт' : 'Синхронизация выключена');
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
