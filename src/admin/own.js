'use strict';
// Раздел «Свои товары»: товары, которых нет ни на складе, ни у партнёров, добавляются вручную - название, отдел, цена и скидка,
// размеры с остатками, описание, фото. На сайте они выглядят и покупаются как обычные (корзина, заказ, скидки лояльности).
// Остаток ведёт сайт: см. src/own.js (поступило минус проданное; отмена и возврат заказа возвращают пару сами).
const express = require('express');
const { html } = require('../html');
const { rub, str } = require('../util');
const { OWN_BASE } = require('../ext');
const { DEPARTMENTS } = require('../model');
const { photoUrl } = require('../shopviews');
const { pager } = require('./layout');
const { DEPTS, MAX_PHOTOS, MAX_PHOTO_BYTES, loadOwn, buildOwnModels, preparePhoto, soldMap } = require('../own');

const PAGE = 30;
const NEW_ROWS = 8;     // пустых строк размеров в форме нового товара
const MORE_ROWS = 4;    // и при правке
const FLT = { all: 'Все', stock: 'В наличии', out: 'Нет в наличии', hidden: 'Скрытые' };
const MAX_PRICE = 100_000_000;

// «12 990», «12990,50» -> число; пусто -> null; мусор -> { error }
function parsePrice(v) {
  const t = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) > MAX_PRICE) return { error: true };
  return { value: Number(t) };
}
const dateOk = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// Размер как его увидит покупатель: «42,5» -> «42.5», «xl» -> «XL»; пустой размер - товар без размера
function normSize(v) {
  let s = str(v, 20).replace(/\s+/g, ' ');
  if (/^\d+,\d$/.test(s)) s = s.replace(',', '.');
  if (/^[a-zA-Z]{1,4}$/.test(s)) s = s.toUpperCase();
  return s;
}
const qtyOk = (v) => /^\d{1,4}$/.test(String(v).trim());

// Читает форму. existing - размеры товара, которые были в форме ([{ id, size, received, sold }]), others - остальные (только для проверки повторов).
// Возвращает { data, errors, sizes }: sizes - итоговые строки { id | null, size, qty (осталось), keep, remove }.
// keep: «осталось» в форме не менялось (совпало с тем, что показывали): поступило не трогаем, иначе заказ, оформленный
// пока форма была открыта, «вернулся» бы на склад.
function readForm(b, existing = [], others = []) {
  const errors = [];
  const name = str(b.name, 160);
  if (name.length < 3) errors.push('Название: не короче 3 символов, например «Кроссовки Nike Air Max 90 «Triple Black»»');
  const dept = String(b.dept || '');
  if (!DEPTS.includes(dept)) errors.push('Отдел: выберите из списка');
  const price = parsePrice(b.price);
  if (price.error) errors.push('Цена: неверное число');
  else if (price.value === null) errors.push('Цена: укажите цену');
  else if (!(price.value > 0)) errors.push('Цена: больше нуля');
  const sale = parsePrice(b.sale_price);
  if (sale.error) errors.push('Цена со скидкой: неверное число');
  let from = str(b.sale_from, 10);
  let to = str(b.sale_to, 10);
  if (sale.value === null) { from = ''; to = ''; }
  else {
    if (!price.error && price.value !== null && !(sale.value < price.value)) errors.push('Цена со скидкой должна быть меньше обычной');
    if ((from && !dateOk(from)) || (to && !dateOk(to)) || (from && to && from > to)) errors.push('Даты скидки: формат ГГГГ-ММ-ДД, «с» не позже «по»');
  }
  const data = {
    name, dept, article: str(b.article, 60), vendor: str(b.vendor, 60), type: str(b.type, 40),
    description: String(b.description || '').replace(/\r/g, '').trim().slice(0, 4000),
    price: price.value, sale: sale.value, from: from || null, to: to || null,
  };

  const sizes = [];
  const seen = new Set(others.map((o) => o.size.toLowerCase()));   // размеры, которых нет в форме, тоже заняты
  const add = (row) => {
    const key = row.size.toLowerCase();
    if (seen.has(key)) { errors.push(`Размер «${row.size || 'без размера'}» указан дважды`); return; }
    seen.add(key);
    sizes.push(row);
  };
  for (const e of existing) {
    if (b[`rm_${e.id}`] === 'on') { sizes.push({ id: e.id, size: e.size, qty: 0, remove: true }); continue; }
    const size = b[`size_${e.id}`] === undefined ? e.size : normSize(b[`size_${e.id}`]);
    const q = String(b[`qty_${e.id}`] ?? '').trim();
    const was = b[`was_${e.id}`];
    if (q !== '' && !qtyOk(q)) { errors.push(`Остаток размера ${size || 'без размера'}: целое число от 0 до 9999`); add({ id: e.id, size, qty: 0, keep: true }); continue; }
    add({ id: e.id, size, qty: q === '' ? 0 : Number(q), keep: was !== undefined && String(was).trim() === q });
  }
  for (let i = 0; i < 40 && (b[`nsize_${i}`] !== undefined || b[`nqty_${i}`] !== undefined); i++) {
    const size = normSize(b[`nsize_${i}`]);
    const q = String(b[`nqty_${i}`] ?? '').trim();
    if (!size && q === '') continue;
    if (q !== '' && !qtyOk(q)) { errors.push(`Остаток размера ${size || 'без размера'}: целое число от 0 до 9999`); continue; }
    add({ id: null, size, qty: q === '' ? 0 : Number(q) });
  }
  // Быстрый набор: размеры списком, у каждого одинаковый остаток. Уже указанные размеры не трогает.
  const quick = String(b.quick_sizes || '').split(/[\s;]+|,(?!\d)/).map(normSize).filter(Boolean);
  if (quick.length) {
    const qq = String(b.quick_qty ?? '').trim();
    if (qq !== '' && !qtyOk(qq)) errors.push('Остаток для быстрого набора: целое число от 0 до 9999');
    else for (const size of quick) if (!seen.has(size.toLowerCase())) add({ id: null, size, qty: qq === '' ? 1 : Number(qq) });
  }
  if (!sizes.some((x) => !x.remove) && !others.length) errors.push('Добавьте хотя бы один размер с остатком. У товара без размера оставьте поле размера пустым и укажите только остаток');
  return { data, errors, sizes };
}


module.exports = function mount({ db, auth, render, router, catalog, settings }) {
  const chip = (cls, text) => html`<span class="chip ${cls}">${text}</span>`;
  const idOf = (req) => (/^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : 0);
  const photoIdOf = (req) => (/^\d+$/.test(String(req.params.photoId)) ? Number(req.params.photoId) : 0);
  const who = (req) => String(req.admin.user.name || '').slice(0, 50);
  const notFound = (req, res) => render(req, res, 'own', {
    title: 'Товар не найден',
    body: html`<div class="card card--pad"><h2>Товар не найден</h2><p>Возможно, его уже удалили.</p><p><a class="btn" href="/admin/own">К списку</a></p></div>`,
  }, 404);

  // ---------- Список ----------
  router.get('/own', auth.require('own'), async (req, res, next) => {
    try {
      const q = str(req.query.q, 60).toLowerCase();
      const flt = FLT[req.query.flt] ? req.query.flt : 'all';
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      let models = buildOwnModels(await loadOwn(db));
      const total = models.length;
      if (q) models = models.filter((m) => `${m.fullName} ${m.own.article} ${m.brand}`.toLowerCase().includes(q));
      if (flt === 'stock') models = models.filter((m) => m.inStock && !m.hiddenOwn);
      if (flt === 'out') models = models.filter((m) => !m.inStock);
      if (flt === 'hidden') models = models.filter((m) => m.hiddenOwn);
      models.sort((a, b) => b.createdAt - a.createdAt || b.own.id - a.own.id);
      const pages = Math.max(1, Math.ceil(models.length / PAGE));
      const shown = models.slice((page - 1) * PAGE, page * PAGE);
      const keep = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ q, flt: flt === 'all' ? '' : flt, ...o })) if (v) u.set(k, v); return u.toString(); };
      const body = html`
      <section class="card card--pad">
        <p class="muted">Здесь товары, которых нет на складе и у партнёров: добавьте название, цену, размеры с остатками и фото, и они появятся на сайте. Остаток ведёт сайт: когда покупатель оформляет заказ, он уменьшается, а при отмене или возврате заказа возвращается сам.</p>
        <form class="filters" method="get" action="/admin/own">
          <label class="search"><input type="search" name="q" value="${q}" placeholder="Название или артикул"></label>
          <select name="flt" data-autosubmit aria-label="Фильтр">${Object.entries(FLT).map(([k, t]) => html`<option value="${k}" ${flt === k ? 'selected' : ''}>${t}</option>`)}</select>
          <button class="btn" type="submit">Найти</button>
          <a class="btn btn--primary" href="/admin/own/new">Добавить товар</a>
        </form>
      </section>
      <section class="card">
        ${shown.length ? html`<div class="tablewrap"><table class="table table--rows"><thead><tr><th>Товар</th><th class="num">Цена</th><th>Размеры и остаток</th><th class="num">Продано</th></tr></thead><tbody>
          ${shown.map((m) => html`<tr class="${m.inStock && !m.hiddenOwn ? '' : 'is-off'}" data-href="/admin/own/${m.own.id}">
            <td><div class="prod">${m.cover ? html`<img src="${photoUrl(m.cover, 360)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="toplist__ph"></span>`}
              <div><b><a href="/admin/own/${m.own.id}">${m.fullName}</a></b><small class="muted">${[DEPARTMENTS[m.dept].title, m.own.article, `№ ${m.own.id}`].filter(Boolean).join(' · ')}</small>
              ${m.hiddenOwn ? chip('chip--gray', 'скрыт') : ''}${m.photos.length ? '' : chip('chip--amber', 'нет фото')}</div></div></td>
            <td class="num">${m.oldPrice ? html`<b>${rub(m.price)}</b><br><s class="muted">${rub(m.oldPrice)}</s>` : html`<b>${rub(m.price)}</b>`}</td>
            <td>${m.sizes.map((s) => html`<span class="sizechip${s.qty > 0 ? '' : ' is-off'}">${s.label}<b>${s.qty}</b></span>`)}</td>
            <td class="num">${m.own.sold}</td></tr>`)}</tbody></table></div>
          ${pager('/admin/own?' + keep({ page: '' }), page, pages)}` : html`<p class="empty-note">${total ? 'Товаров по этим условиям нет.' : 'Своих товаров пока нет. Нажмите «Добавить товар».'}</p>`}
      </section>`;
      await render(req, res, 'own', { title: 'Свои товары', body, wide: true });
    } catch (e) { next(e); }
  });

  // ---------- Форма товара (новый и правка) ----------
  // p - строка loadOwn (правка) или null; posted - то, что прислали (при ошибке поля остаются как введены)
  async function formPage(req, res, { p = null, posted = null, errors = [], status = 200 }) {
    const edit = Boolean(p);
    const val = (key, fallback = '') => (posted ? String(posted[key] ?? '') : String(fallback ?? ''));
    const sizesNow = edit ? p.sizes : [];
    const blank = edit ? MORE_ROWS : NEW_ROWS;
    const sizeRows = edit ? p.sizes.map((s) => ({ ...s, free: Math.max(0, s.received - s.sold) })) : [];
    const m = edit ? buildOwnModels([p])[0] : null;
    const needPhoto = Boolean((await settings.get()).requirePhoto);
    const body = html`
      ${errors.length ? html`<div class="flash flash--err" role="alert"><b>Ничего не сохранено:</b><ul>${errors.slice(0, 12).map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <form method="post" action="${edit ? `/admin/own/${p.id}` : '/admin/own'}" class="card card--pad ownform">${req.adminCsrf}
        <h2>${edit ? 'Основное' : 'Новый товар'}</h2>
        <div class="mform__grid">
          <label class="field field--wide">Название на сайте<input name="name" value="${val('name', edit ? p.name : '')}" maxlength="160" required placeholder="Кроссовки Nike Air Max 90 «Triple Black»">
            <small class="muted">Начните с вида товара (Кроссовки, Худи, Сумка), затем бренд и модель; цвет можно взять в «ёлочки». Так сайт сам определит бренд и фильтры.</small></label>
          <label class="field">Отдел
            <select name="dept">${DEPTS.map((d) => html`<option value="${d}" ${val('dept', edit ? p.dept : 'shoes') === d ? 'selected' : ''}>${DEPARTMENTS[d].title}</option>`)}</select></label>
          <label class="field">Артикул <span class="muted">(необязательно)</span><input name="article" value="${val('article', edit ? p.article : '')}" maxlength="60"></label>
          <label class="field">Бренд <span class="muted">(если его нет в названии)</span><input name="vendor" value="${val('vendor', edit ? p.vendor : '')}" maxlength="60"></label>
          <label class="field">Вид товара <span class="muted">(если название с него не начинается)</span><input name="type" value="${val('type', edit ? p.type : '')}" maxlength="40" placeholder="Кроссовки"></label>
          <label class="field">Цена, ₽<input name="price" value="${val('price', edit ? Number(p.price) : '')}" inputmode="decimal" required placeholder="12 990"></label>
          <label class="field">Цена со скидкой, ₽ <span class="muted">(акция)</span><input name="sale_price" value="${val('sale_price', edit && p.sale_price ? Number(p.sale_price) : '')}" inputmode="decimal" placeholder="нет акции"></label>
          <label class="field">Скидка с<input type="date" name="sale_from" value="${val('sale_from', edit ? p.sale_from || '' : '')}"></label>
          <label class="field">Скидка по<input type="date" name="sale_to" value="${val('sale_to', edit ? p.sale_to || '' : '')}"></label>
          <label class="field field--wide">Описание <span class="muted">(абзацы разделяйте пустой строкой)</span>
            <textarea name="description" rows="5" maxlength="4000">${val('description', edit ? p.description : '')}</textarea></label>
        </div>
        <h2>Размеры и остатки</h2>
        <p class="muted">${edit ? 'В колонке «Осталось» - сколько пар (штук) лежит сейчас: проданное из заказов сайт вычитает сам. Исправили цифру - сайт запомнит новый остаток.' : 'Укажите размеры и сколько штук каждого есть. У товара без размера оставьте поле размера пустым и впишите только остаток.'}</p>
        <div class="tablewrap"><table class="table sizerows"><thead><tr><th>Размер</th><th>${edit ? 'Осталось' : 'Штук'}</th>${edit ? html`<th class="num">Продано</th><th>Убрать</th>` : ''}</tr></thead><tbody>
          ${sizeRows.map((s) => html`<tr><td><input class="pricein pricein--s" name="size_${s.id}" value="${val(`size_${s.id}`, s.size)}" maxlength="20" aria-label="Размер" placeholder="без размера"></td>
            <td><input class="pricein pricein--s" name="qty_${s.id}" value="${val(`qty_${s.id}`, s.free)}" inputmode="numeric" aria-label="Осталось"><input type="hidden" name="was_${s.id}" value="${s.free}"></td>
            <td class="num">${s.sold}</td><td><input type="checkbox" name="rm_${s.id}" ${val(`rm_${s.id}`) === 'on' ? 'checked' : ''} aria-label="Убрать размер"></td></tr>`)}
          ${Array.from({ length: blank }, (_, i) => html`<tr><td><input class="pricein pricein--s" name="nsize_${i}" value="${val(`nsize_${i}`)}" maxlength="20" aria-label="Новый размер" placeholder="${edit ? 'новый размер' : i === 0 ? '41' : ''}"></td>
            <td><input class="pricein pricein--s" name="nqty_${i}" value="${val(`nqty_${i}`)}" inputmode="numeric" aria-label="Штук"></td>${edit ? html`<td></td><td></td>` : ''}</tr>`)}
        </tbody></table></div>
        ${edit ? html`<input type="hidden" name="sids" value="${sizesNow.map((s) => s.id).join(',')}">` : ''}
        <div class="mform__grid">
          <label class="field field--wide">Быстрый набор: размеры списком <span class="muted">(через пробел, например 38 39 40 41)</span><input name="quick_sizes" value="${val('quick_sizes')}" maxlength="200" placeholder="38 39 40 41 42"></label>
          <label class="field">По сколько штук каждого<input name="quick_qty" value="${val('quick_qty')}" inputmode="numeric" placeholder="1"></label>
        </div>
        <div class="mform__foot"><button class="btn btn--primary" type="submit">${edit ? 'Сохранить' : 'Добавить товар'}</button>
          ${edit ? '' : html`<span class="muted">Фото добавляются на следующем шаге, после первого сохранения.</span>`}</div>
      </form>
      ${edit ? html`
      <section class="card card--pad"><h2>Фото</h2>
        <p class="muted">Первое фото - главное: оно на карточке в каталоге. JPEG, PNG или WebP до 12 МБ, не больше ${MAX_PHOTOS} штук на товар. Сайт сам приводит фото к единому виду: товар по центру на белом квадрате. Можно выбрать сразу несколько файлов.</p>
        ${!p.photos.length && needPhoto ? html`<p class="alert">Пока у товара нет фото, на сайте его не видно: включено правило «показывать только модели с фото» (раздел «Витрина и каталог»). Загрузите фото, и товар появится.</p>` : ''}
        ${p.photos.length ? html`<div class="ownphotos">${p.photos.map((id, i) => html`<figure class="ownphoto">
          <img src="${photoUrl(OWN_BASE + id, 360)}" alt="Фото ${i + 1}" width="160" height="160" loading="lazy">
          <figcaption>${i === 0 ? chip('chip--green', 'главное') : html`<form method="post" action="/admin/own/${p.id}/photos/${id}/cover">${req.adminCsrf}<button class="btn btn--sm" type="submit">Сделать главным</button></form>`}
            <form method="post" action="/admin/own/${p.id}/photos/${id}/delete">${req.adminCsrf}<button class="btn btn--sm btn--ghost" type="submit">Удалить</button></form></figcaption></figure>`)}</div>` : html`<p class="empty-note">Фото пока нет: без фото товар выглядит хуже, добавьте хотя бы одно.</p>`}
        ${p.photos.length < MAX_PHOTOS ? html`<form class="heromedia__form" action="/admin/own/${p.id}/photos" method="post" data-hero-upload data-csrf="${req.admin.csrf}">${req.adminCsrf}
          <label class="field">Добавить фото<input type="file" name="file" accept="image/jpeg,image/png,image/webp" multiple required data-hero-file></label>
          <button class="btn btn--primary" type="submit">Загрузить</button>
          <progress class="heromedia__progress" max="100" value="0" hidden data-hero-progress></progress>
          <p class="heromedia__msg" role="status" data-hero-msg></p></form>` : ''}
      </section>
      <section class="card card--pad"><h2>Показ на сайте</h2>
        <p>${p.active ? chip('chip--green', 'товар на сайте') : chip('chip--gray', 'товар скрыт')}</p>
        <form method="post" action="/admin/own/${p.id}/hide">${req.adminCsrf}<input type="hidden" name="hide" value="${p.active ? '1' : '0'}">
          <button class="btn" type="submit">${p.active ? 'Скрыть с сайта' : 'Вернуть на сайт'}</button>
          <span class="muted">Скрытый товар не виден покупателям, но остаётся здесь вместе с заказами и остатками.</span></form>
        <details class="dangerzone"><summary>Удалить товар насовсем</summary>
          <p class="muted">Удалить можно только товар, которого нет ни в одном заказе: иначе скройте его. Фото и размеры удаляются вместе с ним.</p>
          <form method="post" action="/admin/own/${p.id}/delete">${req.adminCsrf}<button class="btn btn--ghost" type="submit">Удалить товар</button></form></details>
      </section>` : ''}`;
    const site = edit && m && p.active ? html`<a class="btn btn--ghost btn--sm" href="/p/${m.slug}" target="_blank" rel="noopener">Открыть на сайте</a> ` : '';
    await render(req, res, 'own', {
      title: edit ? 'Свой товар' : 'Новый товар', body, wide: true,
      actions: html`${site}<a class="btn btn--ghost btn--sm" href="/admin/own">К списку</a>`,
    }, status);
  }

  router.get('/own/new', auth.require('own'), async (req, res, next) => { try { await formPage(req, res, {}); } catch (e) { next(e); } });

  router.get('/own/:id', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      const p = id ? (await loadOwn(db, { id }))[0] : null;
      if (!p) return notFound(req, res);
      await formPage(req, res, { p });
    } catch (e) { next(e); }
  });

  const columns = (d) => [d.name, d.vendor, d.type, d.dept, d.article, d.description, d.price, d.sale, d.from, d.to];

  router.post('/own', auth.require('own'), async (req, res, next) => {
    try {
      const { data, errors, sizes } = readForm(req.body);
      if (errors.length) return formPage(req, res, { posted: req.body, errors, status: 422 });
      const id = await db.tx(async (c) => {
        const ins = await c.query(
          `INSERT INTO webshop.own_products (name, vendor, type, dept, article, description, price, sale_price, sale_from, sale_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [...columns(data), who(req)]);
        const pid = ins.rows[0].id;
        let i = 0;
        for (const s of sizes) await c.query('INSERT INTO webshop.own_sizes (product_id, size, received, sort) VALUES ($1,$2,$3,$4)', [pid, s.size, s.qty, i++]);
        return pid;
      });
      catalog.invalidate();
      res.flash('ok', 'Товар добавлен. Теперь загрузите фото');
      res.redirect(`/admin/own/${id}`);
    } catch (e) { next(e); }
  });

  router.post('/own/:id', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      const p = id ? (await loadOwn(db, { id }))[0] : null;
      if (!p) return notFound(req, res);
      const shownIds = new Set(String(req.body.sids || '').split(',').map((x) => parseInt(x, 10)).filter(Number.isInteger));
      const existing = p.sizes.filter((s) => shownIds.has(s.id));
      const others = p.sizes.filter((s) => !shownIds.has(s.id));
      const { data, errors, sizes } = readForm(req.body, existing, others);
      if (errors.length) return formPage(req, res, { p, posted: req.body, errors, status: 422 });
      await db.tx(async (c) => {
        await c.query('SELECT id FROM webshop.own_products WHERE id = $1 FOR UPDATE', [id]);
        await c.query(
          `UPDATE webshop.own_products SET name = $2, vendor = $3, type = $4, dept = $5, article = $6, description = $7, price = $8, sale_price = $9,
                  sale_from = $10, sale_to = $11, updated_at = NOW() WHERE id = $1`, [id, ...columns(data)]);
        // проданное считаем заново внутри транзакции: пока форма была открыта, мог прийти заказ
        const sold = await soldMap(c, p.sizes.map((s) => OWN_BASE + s.id));
        const cur = new Map((await c.query('SELECT id, size, received FROM webshop.own_sizes WHERE product_id = $1', [id])).rows.map((r) => [r.id, r]));
        // сначала освобождаем названия переименованных размеров: размеры меняются местами (40 <-> 41) без нарушения уникальности
        const renamed = sizes.filter((s) => s.id && cur.has(s.id) && !s.remove && cur.get(s.id).size !== s.size).map((s) => s.id);
        if (renamed.length) await c.query("UPDATE webshop.own_sizes SET size = '~' || id::text WHERE id = ANY($1)", [renamed]);
        for (const s of sizes) {
          if (!s.id || !cur.has(s.id)) continue;
          if (s.remove) { await c.query('DELETE FROM webshop.own_sizes WHERE id = $1 AND product_id = $2', [s.id, id]); continue; }
          const received = s.keep ? cur.get(s.id).received : s.qty + (sold.get(OWN_BASE + s.id) || 0);
          await c.query('UPDATE webshop.own_sizes SET size = $2, received = $3 WHERE id = $1 AND product_id = $4', [s.id, s.size, received, id]);
        }
        const next0 = (await c.query('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM webshop.own_sizes WHERE product_id = $1', [id])).rows[0].n;
        let i = 0;
        for (const s of sizes.filter((x) => !x.id)) await c.query('INSERT INTO webshop.own_sizes (product_id, size, received, sort) VALUES ($1,$2,$3,$4)', [id, s.size, s.qty, next0 + i++]);
      });
      catalog.invalidate();
      res.flash('ok', 'Сохранено');
      res.redirect(`/admin/own/${id}`);
    } catch (e) { next(e); }
  });

  // ---------- Фото ----------
  // Файл приходит «как есть» (не формой), как логотип и фон главной: токен csrf - в заголовке X-CSRF-Token
  router.post('/own/:id/photos',
    express.raw({ type: () => true, limit: `${Math.ceil(MAX_PHOTO_BYTES / 1048576)}mb` }),
    (req, res, next) => {
      req.photoUpload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      req.body = { _csrf: req.get('x-csrf-token') || '' };
      next();
    },
    auth.require('own'),
    async (req, res, next) => {
      try {
        const id = idOf(req);
        if (!req.photoUpload.length) return res.status(400).json({ error: 'Файл пустой' });
        const jpg = await preparePhoto(req.photoUpload);
        if (!jpg) return res.status(400).json({ error: 'Это не картинка: нужен JPEG, PNG или WebP' });
        const result = await db.tx(async (c) => {
          const own = await c.query('SELECT id FROM webshop.own_products WHERE id = $1 FOR UPDATE', [id]);
          if (!own.rows[0]) return { status: 404, error: 'Товар не найден' };
          const n = (await c.query('SELECT COUNT(*)::int AS n FROM webshop.own_photos WHERE product_id = $1', [id])).rows[0].n;
          if (n >= MAX_PHOTOS) return { status: 400, error: `Не больше ${MAX_PHOTOS} фото на товар: удалите лишние` };
          await c.query(
            'INSERT INTO webshop.own_photos (product_id, position, data) VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM webshop.own_photos WHERE product_id = $1), 0), $2)', [id, jpg]);
          return { ok: true };
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        catalog.invalidate();
        res.json({ ok: true });
      } catch (e) { next(e); }
    });

  router.post('/own/:id/photos/:photoId/cover', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      await db.query(
        `UPDATE webshop.own_photos SET position = (SELECT COALESCE(MIN(position), 0) - 1 FROM webshop.own_photos WHERE product_id = $1)
          WHERE id = $2 AND product_id = $1`, [id, photoIdOf(req)]);
      catalog.invalidate();
      res.redirect(`/admin/own/${id}`);
    } catch (e) { next(e); }
  });

  router.post('/own/:id/photos/:photoId/delete', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      await db.query('DELETE FROM webshop.own_photos WHERE id = $2 AND product_id = $1', [id, photoIdOf(req)]);
      catalog.invalidate();
      res.redirect(`/admin/own/${id}`);
    } catch (e) { next(e); }
  });

  // ---------- Показ и удаление ----------
  router.post('/own/:id/hide', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      const hide = req.body.hide === '1';
      const r = await db.query('UPDATE webshop.own_products SET active = $2, updated_at = NOW() WHERE id = $1', [id, !hide]);
      if (!r.rowCount) return notFound(req, res);
      catalog.invalidate();
      res.flash('ok', hide ? 'Товар скрыт с сайта' : 'Товар снова на сайте');
      res.redirect(`/admin/own/${id}`);
    } catch (e) { next(e); }
  });

  router.post('/own/:id/delete', auth.require('own'), async (req, res, next) => {
    try {
      const id = idOf(req);
      const p = id ? (await loadOwn(db, { id }))[0] : null;
      if (!p) return notFound(req, res);
      const used = await db.query('SELECT 1 FROM webshop.order_items WHERE product_id = ANY($1) LIMIT 1', [p.sizes.map((s) => OWN_BASE + s.id)]);
      if (used.rows[0]) {
        res.flash('err', 'Товар есть в заказах, поэтому удалить его нельзя. Скройте его с сайта: заказы и остатки сохранятся');
        return res.redirect(`/admin/own/${id}`);
      }
      await db.query('DELETE FROM webshop.own_products WHERE id = $1', [id]);
      catalog.invalidate();
      res.flash('ok', 'Товар удалён');
      res.redirect('/admin/own');
    } catch (e) { next(e); }
  });
};
