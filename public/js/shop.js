/* Витрина: поиск с подсказками, корзина без перезагрузки, фильтры, галерея, оформление заказа. Без библиотек. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ICON = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s; };

  /* ---------- Мобильное меню ---------- */
  const nav = $('#nav');
  const burger = $('[data-nav-toggle]');
  if (nav && burger) {
    burger.addEventListener('click', () => nav.classList.toggle('is-open'));
    document.addEventListener('click', (e) => { if (nav.classList.contains('is-open') && !nav.contains(e.target) && !burger.contains(e.target)) nav.classList.remove('is-open'); });
  }

  /* ---------- Подсказки поиска ---------- */
  function renderSuggest(out, data, q, compact) {
    out.replaceChildren();
    if (!q) {
      const hint = el('div', 'sug__hint');
      hint.appendChild(el('p', null, 'Начните вводить название модели, бренд или артикул.'));
      const list = el('div', 'chiplist');
      ['Nike Dunk', 'New Balance 9060', 'adidas Samba', 'Timberland', 'Crocs'].forEach((t) => { const a = el('a', null, t); a.href = '/catalog?q=' + encodeURIComponent(t); list.appendChild(a); });
      hint.appendChild(list);
      out.appendChild(hint);
      return;
    }
    if (!data.items.length) {
      out.appendChild(el('p', 'sug__empty', 'Ничего не нашли по запросу «' + q + '». Попробуйте название бренда или часть артикула.'));
      return;
    }
    const wrap = el('div', 'sug');
    if (!compact) {
      const br = el('div', 'sug__brands');
      if (data.brands.length) {
        br.appendChild(el('h5', null, 'Бренды'));
        data.brands.forEach((b) => { const a = el('a'); a.href = b.url; a.appendChild(el('b', null, b.name)); a.appendChild(el('span', null, String(b.n))); br.appendChild(a); });
      }
      wrap.appendChild(br);
    } else wrap.style.display = 'block';
    const right = el('div');
    right.appendChild(el('p', 'sug__title', 'Модели'));
    const list = el('div', 'sug__list');
    data.items.forEach((it) => {
      const a = el('a', 'sug__item'); a.href = it.url;
      const img = el('img'); img.alt = ''; img.width = 64; img.height = 64; if (it.img) img.src = it.img;
      const mid = el('div'); mid.appendChild(el('b', null, it.title)); mid.appendChild(el('small', null, it.out ? 'Нет в наличии' : it.sub));
      a.append(img, mid, el('i', null, it.price));
      list.appendChild(a);
    });
    right.appendChild(list);
    const all = el('a', 'link sug__all', 'Показать все ' + data.total); all.href = data.url; all.appendChild(ICON('arrow-right'));
    right.appendChild(all);
    wrap.appendChild(right);
    out.appendChild(wrap);
  }

  function attachSuggest(input, out, compact) {
    let seq = 0;
    const run = debounce(async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (!q) { renderSuggest(out, { items: [], brands: [] }, '', compact); return; }
      try {
        const r = await fetch('/api/suggest?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } });
        const data = await r.json();
        if (my === seq) renderSuggest(out, data, q, compact);
      } catch (e) { /* без подсказок обойдёмся */ }
    }, 140);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = $$('.sug__item', out);
      if (!items.length) return;
      e.preventDefault();
      let i = items.findIndex((x) => x.classList.contains('is-hover'));
      items.forEach((x) => x.classList.remove('is-hover'));
      i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[i].classList.add('is-hover');
      items[i].scrollIntoView({ block: 'nearest' });
    });
    input.form.addEventListener('submit', (e) => {
      const hov = $('.sug__item.is-hover', out);
      if (hov) { e.preventDefault(); location.href = hov.href; }
    });
    return run;
  }

  const panel = $('#search');
  const panelInput = $('[data-search-input]', panel || document);
  if (panel && panelInput) {
    const out = $('[data-search-out]', panel);
    attachSuggest(panelInput, out, false);
    const open = () => { panel.hidden = false; panelInput.focus(); renderSuggest(out, { items: [], brands: [] }, panelInput.value.trim(), false); if (panelInput.value.trim()) panelInput.dispatchEvent(new Event('input')); };
    const close = () => { panel.hidden = true; };
    $$('[data-search-open]').forEach((b) => b.addEventListener('click', () => (panel.hidden ? open() : close())));
    $('[data-search-close]').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); open(); } });
  }
  // Поле на главной: подсказки выпадают под ним
  const inline = $('input[data-search-inline]');
  if (inline) {
    const pop = el('div', 'sug-pop'); pop.hidden = true;
    inline.form.appendChild(pop);
    const run = attachSuggest(inline, pop, true);
    inline.addEventListener('input', () => { pop.hidden = !inline.value.trim(); });
    document.addEventListener('click', (e) => { if (!inline.form.contains(e.target)) pop.hidden = true; });
    void run;
  }

  /* ---------- Корзина ---------- */
  const toast = $('#toast');
  let toastTimer;
  function showToast(node, err) {
    if (!toast) return;
    toast.replaceChildren(node);
    toast.className = 'toast' + (err ? ' toast--err' : '');
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, err ? 5000 : 6500);
  }
  function setCount(n) {
    $$('[data-cart-count]').forEach((c) => { c.textContent = n || ''; c.classList.toggle('is-empty', !n); c.classList.remove('bump'); void c.offsetWidth; if (n) c.classList.add('bump'); });
  }
  const addForm = $('[data-add-form]');
  if (addForm) {
    const hint = $('[data-size-hint]', addForm);
    $$('input[name="pid"]', addForm).forEach((r) => r.addEventListener('change', () => {
      if (!hint) return;
      const left = parseInt(r.dataset.left, 10);
      hint.textContent = 'Размер ' + r.dataset.sizeLabel + (left <= 2 ? ': осталось ' + left + ' шт.' : ': в наличии');
    }));
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const picked = $('input[name="pid"]:checked', addForm);
      const btn = $('[data-add-btn]', addForm);
      if (!picked) {
        if (hint) { hint.textContent = 'Сначала выберите размер'; hint.style.color = 'var(--bad)'; }
        const g = $('.sizes--pdp', addForm); if (g) g.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      btn.disabled = true;
      try {
        const r = await fetch('/cart/add', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fetch': '1', accept: 'application/json' }, body: new URLSearchParams({ pid: picked.value }) });
        const data = await r.json();
        if (!data.ok) { const n = el('div'); n.appendChild(el('b', null, data.error || 'Не получилось добавить')); showToast(n, true); if (typeof data.count === 'number') setCount(data.count); return; }
        setCount(data.count);
        const n = el('div');
        const row = el('div', 'toast__row');
        const img = el('img'); img.alt = ''; if (data.item.img) img.src = data.item.img;
        const t = el('div'); t.appendChild(el('b', null, data.item.title)); t.appendChild(el('small', null, 'Размер ' + data.item.size + ' · ' + data.item.price));
        row.append(img, t);
        const act = el('div', 'toast__actions');
        const go = el('a', 'btn btn--sm', 'Корзина'); go.href = '/cart';
        const more = el('button', 'btn btn--sm btn--ghost', 'Продолжить'); more.type = 'button'; more.addEventListener('click', () => { toast.hidden = true; });
        act.append(go, more);
        n.append(el('p', 'eyebrow', 'Добавлено в корзину'), row, act);
        showToast(n);
      } catch (err) { addForm.submit(); } finally { btn.disabled = false; }
    });
  }

  /* ---------- Галерея ---------- */
  const gallery = $('[data-gallery]');
  if (gallery) {
    const main = $('[data-gallery-main]', gallery);
    $$('[data-gallery-thumb]', gallery).forEach((b) => b.addEventListener('click', () => {
      $$('[data-gallery-thumb]', gallery).forEach((x) => x.classList.toggle('is-active', x === b));
      main.removeAttribute('srcset');
      main.src = b.dataset.full;
    }));
  }

  /* ---------- Фильтры каталога ---------- */
  const filters = $('#filters');
  if (filters) {
    $$('[data-filters-open]').forEach((b) => b.addEventListener('click', () => { filters.classList.add('is-open'); document.body.classList.add('no-scroll'); }));
    $$('[data-filters-close]').forEach((b) => b.addEventListener('click', () => { filters.classList.remove('is-open'); document.body.classList.remove('no-scroll'); }));
  }
  const submitBtn = filters && $('.filters__actions .btn:not(.btn--ghost)', filters);
  $$('form[data-autosubmit]').forEach((f) => {
    const send = debounce(() => f.submit(), 350);
    const count = debounce(async () => {
      if (!submitBtn) return;
      const p = new URLSearchParams(new FormData(f));
      for (const [k, v] of [...p]) if (v === '') p.delete(k);
      try { const r = await fetch('/api/count?' + p); const d = await r.json(); submitBtn.textContent = 'Показать ' + d.label; } catch (e) { /* ничего */ }
    }, 200);
    f.addEventListener('change', () => {
      if (f.hasAttribute('data-count-form') && isMobile()) count();
      else send();
    });
  });

  /* ---------- Подбор пары на главной ---------- */
  const finder = $('[data-finder]');
  if (finder) {
    const form = $('form', finder);
    const label = $('[data-finder-count]', finder);
    const refresh = debounce(async () => {
      const p = new URLSearchParams(new FormData(form));
      for (const [k, v] of [...p]) if (v === '') p.delete(k);
      try { const r = await fetch('/api/count?' + p); const d = await r.json(); label.textContent = d.label; } catch (e) { /* оставим как есть */ }
    }, 180);
    $$('[data-finder-input]', finder).forEach((i) => i.addEventListener('change', refresh));
    form.addEventListener('submit', () => { $$('select, input', form).forEach((i) => { if (i.type !== 'checkbox' && i.type !== 'radio' && i.value === '') i.disabled = true; if (i.type === 'radio' && i.checked && i.value === '') i.disabled = true; }); });
  }

  /* ---------- Оформление заказа ---------- */
  const co = $('[data-checkout]');
  if (co) {
    const rub = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
    const subtotal = parseFloat($('[data-sum-sub]', co).dataset.value) || 0;
    const methods = $$('[data-method]', co);
    const paneP = $('[data-pane="pickup"]', co);
    const paneA = $('[data-pane="address"]', co);
    const modeBox = $('[data-tc-mode]', co);
    const fAddr = $('[data-field-address]', co);
    const fTc = $('[data-field-tcpoint]', co);
    const cityIn = $('[data-city]', co);
    const cityHint = $('[data-city-hint]', co);
    const payHint = $('[data-pay-hint]', co);
    const codRadio = $('input[name="pay"][value="cod"]', co);
    const onlineRadio = $('input[name="pay"][value="online"]', co);
    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

    // Расчёт по API перевозчика (СДЭК): город из списка, пункт выдачи из списка, цена и срок от сервера. При сбое API - прежняя форма.
    const cityCode = $('[data-city-code]', co);
    const cityList = $('[data-city-list]', co);
    const pvz = $('[data-pvz]', co);
    const pvzQ = $('[data-pvz-q]', co);
    const pvzList = $('[data-pvz-list]', co);
    const pvzCode = $('[data-pvz-code]', co);
    const pvzChosen = $('[data-pvz-chosen]', co);
    const etaHint = $('[data-eta-hint]', co);
    const api = { failed: false, quote: null, key: '' };

    function current() {
      const r = $('input[name="delivery"]:checked', co);
      const m = r && r.closest('[data-method]');
      return m ? { code: m.dataset.code, api: m.dataset.api === '1', kind: m.dataset.kind, price: +m.dataset.price, doorExtra: +m.dataset.doorExtra, freeFrom: m.dataset.freeFrom === '' ? null : +m.dataset.freeFrom, cities: m.dataset.cities } : null;
    }
    const modeNow = () => (($('input[name="mode"]:checked', co) || {}).value === 'door' ? 'door' : 'point');
    const apiOn = (m) => Boolean(m && m.api && !api.failed);
    const quoteKey = (m) => m.code + '|' + cityCode.value + '|' + modeNow();
    async function getJson(url) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        let d = null;
        try { d = await r.json(); } catch (e) { /* не JSON */ }
        return { ok: r.ok, status: r.status, data: d || {} };
      } catch (e) { return { ok: false, status: 0, data: {} }; }
    }
    function apiFailed() {
      api.failed = true; api.quote = null;
      cityCode.value = ''; pvzCode.value = ''; cityList.hidden = true;
      etaHint.textContent = 'Не удалось рассчитать доставку онлайн: показана ориентировочная цена, менеджер уточнит точную. Укажите город и пункт выдачи текстом.';
      etaHint.hidden = false;
      update();
    }

    function update() {
      const m = current();
      if (!m) return;
      const mode = modeNow();
      const door = m.kind === 'courier' || (m.kind === 'tc' && mode === 'door');
      const useApi = apiOn(m);
      paneP.hidden = m.kind !== 'pickup';
      paneA.hidden = m.kind === 'pickup';
      modeBox.hidden = m.kind !== 'tc';
      fAddr.hidden = !door;
      fTc.hidden = door || useApi;
      pvz.hidden = !(useApi && !door && cityCode.value);
      if (!m.api) etaHint.hidden = true;
      const free = m.freeFrom !== null && subtotal >= m.freeFrom;
      let price = free ? 0 : m.price + (door ? m.doorExtra : 0);
      if (useApi && api.quote && api.key === quoteKey(m)) price = api.quote.price;
      $('[data-sum-delivery]', co).textContent = price ? rub(price) : 'Бесплатно';
      $('[data-sum-total]', co).textContent = rub(subtotal + price);
      // Город и ограничения курьера
      const list = String(m.cities || '').split(',').map(norm).filter(Boolean);
      const bad = list.length && cityIn.value.trim() && !list.includes(norm(cityIn.value));
      cityHint.hidden = !bad;
      if (bad) cityHint.textContent = 'Этот способ работает только в: ' + m.cities + '. Выберите транспортную компанию для другого города.';
      // ТК - только предоплата
      const tc = m.kind === 'tc';
      codRadio.disabled = tc;
      payHint.hidden = !tc;
      if (tc && codRadio.checked) onlineRadio.checked = true;
    }

    async function refreshQuote() {
      const m = current();
      if (!apiOn(m) || !cityCode.value) { api.quote = null; if (m && m.api && !api.failed) etaHint.hidden = true; update(); return; }
      const key = quoteKey(m);
      const r = await getJson('/api/delivery/quote?' + new URLSearchParams({ method: m.code, city: cityCode.value, mode: modeNow() }));
      const now = current();
      if (!now || quoteKey(now) !== key) return; // пока считали, выбор изменился
      if (r.ok) {
        api.quote = r.data; api.key = key;
        const a = r.data.etaMin, b = r.data.etaMax;
        const eta = a && b ? 'Срок доставки: ' + (a === b ? a : a + '-' + b) + ' дн.' : '';
        etaHint.textContent = (eta + (r.data.free ? ' Доставка бесплатная.' : '')).trim();
        etaHint.hidden = !etaHint.textContent;
        update();
      } else if (r.status === 422) {
        api.quote = null;
        etaHint.textContent = (r.data.error || 'Сюда доставка недоступна') + '. Выберите другой город или способ.';
        etaHint.hidden = false;
        update();
      } else apiFailed();
    }

    const loadCities = debounce(async () => {
      const m = current();
      const q = cityIn.value.trim();
      if (!apiOn(m) || q.length < 2) { cityList.hidden = true; return; }
      const r = await getJson('/api/delivery/cities?' + new URLSearchParams({ method: m.code, q }));
      if (cityIn.value.trim() !== q) return;
      if (!r.ok) { cityList.hidden = true; if (r.status !== 422) apiFailed(); return; }
      cityList.replaceChildren();
      (r.data.cities || []).forEach((c) => {
        const li = el('li');
        const b = el('button', 'suggest__i');
        b.type = 'button';
        b.appendChild(el('b', null, c.name));
        if (c.region) b.appendChild(el('small', null, c.region));
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          cityIn.value = c.name; cityCode.value = String(c.code); cityList.hidden = true;
          pvzCode.value = ''; pvzChosen.textContent = ''; pvzQ.value = '';
          refreshQuote(); fetchPoints(''); update();
        });
        li.appendChild(b);
        cityList.appendChild(li);
      });
      cityList.hidden = !cityList.children.length;
    }, 250);

    async function fetchPoints(q) {
      const m = current();
      if (!apiOn(m) || !cityCode.value || modeNow() === 'door') return;
      const r = await getJson('/api/delivery/points?' + new URLSearchParams({ method: m.code, city: cityCode.value, q }));
      if (!r.ok) { if (r.status === 422) pvzList.replaceChildren(el('p', 'hint', r.data.error || 'Пункты недоступны')); else apiFailed(); return; }
      pvzList.replaceChildren();
      const pts = r.data.points || [];
      if (!pts.length) pvzList.appendChild(el('p', 'hint', 'Ничего не найдено. Измените запрос.'));
      pts.forEach((p) => {
        const lab = el('label', 'point');
        const inp = el('input');
        inp.type = 'radio'; inp.name = 'pvz_pick'; inp.value = p.code; inp.checked = pvzCode.value === p.code;
        inp.addEventListener('change', () => { pvzCode.value = p.code; pvzChosen.textContent = 'Выбрано: ' + p.address; });
        const sp = el('span');
        sp.appendChild(el('b', null, p.title || p.address));
        sp.appendChild(el('small', null, p.title ? p.address + (p.hours ? ' · ' + p.hours : '') : (p.hours || '')));
        lab.append(inp, sp);
        pvzList.appendChild(lab);
        if (inp.checked) pvzChosen.textContent = 'Выбрано: ' + p.address;
      });
      if (!q && r.data.total > pts.length) pvzList.appendChild(el('p', 'hint', 'Показаны первые пункты, остальные ищите по улице или метро.'));
    }
    const searchPoints = debounce(() => fetchPoints(pvzQ.value.trim()), 250);
    pvzQ.addEventListener('input', searchPoints);
    pvzQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

    co.addEventListener('change', (e) => {
      update();
      if (e.target.name === 'mode' || e.target.name === 'delivery') { refreshQuote(); fetchPoints(pvzQ.value.trim()); }
    });
    cityIn.addEventListener('input', () => {
      if (cityCode.value) { cityCode.value = ''; pvzCode.value = ''; pvzChosen.textContent = ''; api.quote = null; etaHint.hidden = true; }
      update();
      loadCities();
    });
    document.addEventListener('click', (e) => { if (!cityList.contains(e.target) && e.target !== cityIn) cityList.hidden = true; });
    update();
    if (cityCode.value && current() && current().api) { refreshQuote(); fetchPoints(pvzCode.value); } // страница вернулась после ошибки в форме

    const phone = $('[data-phone]', co);
    phone.addEventListener('input', () => {
      let d = phone.value.replace(/\D/g, '');
      if (!d) { phone.value = ''; return; }
      if (d[0] === '8') d = '7' + d.slice(1);
      if (d[0] !== '7') d = '7' + d;
      d = d.slice(0, 11);
      let s = '+7';
      if (d.length > 1) s += ' ' + d.slice(1, 4);
      if (d.length > 4) s += ' ' + d.slice(4, 7);
      if (d.length > 7) s += '-' + d.slice(7, 9);
      if (d.length > 9) s += '-' + d.slice(9, 11);
      phone.value = s;
    });
    co.addEventListener('submit', (e) => {
      const m = current();
      if (apiOn(m)) {
        if (!cityCode.value) { e.preventDefault(); cityHint.textContent = 'Выберите город из выпадающего списка'; cityHint.hidden = false; cityIn.focus(); return; }
        if (modeNow() === 'point' && !pvzCode.value) { e.preventDefault(); pvzChosen.textContent = 'Выберите пункт выдачи из списка'; pvz.scrollIntoView({ block: 'center' }); return; }
      }
      const b = $('[data-submit]', co); b.disabled = true; b.textContent = 'Оформляем…';
    });
  }

  /* ---------- Уведомление о cookie ---------- */
  const cookie = $('#cookie');
  if (cookie) {
    let seen = false;
    try { seen = localStorage.getItem('cookie-ok') === '1'; } catch (e) { /* приватный режим */ }
    cookie.hidden = seen;
    $('[data-cookie-ok]', cookie).addEventListener('click', () => { cookie.hidden = true; try { localStorage.setItem('cookie-ok', '1'); } catch (e) { /* ладно */ } });
  }
})();
