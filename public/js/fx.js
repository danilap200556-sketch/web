/* Оформление v2: появление блоков при прокрутке, шапка и шкала прокрутки, параллакс, карусели, выезжающая корзина.
   Без внешних библиотек. Все эффекты отключаются при prefers-reduced-motion. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const rub = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';

  /* ---------- Шапка, шкала прокрутки, параллакс ---------- */
  const head = $('#head');
  const bar = $('[data-progress]');
  const par = $$('[data-parallax]');
  let ticking = false;
  function frame() {
    ticking = false;
    const y = window.scrollY;
    const max = root.scrollHeight - window.innerHeight;
    if (head) head.classList.toggle('is-scrolled', y > 24);
    if (bar) bar.style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : '0');
    if (!reduce) {
      for (const p of par) {
        const r = p.getBoundingClientRect();
        if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
        const f = parseFloat(p.dataset.parallax) || 0;
        p.style.setProperty('--py', ((r.top + r.height / 2 - window.innerHeight / 2) * f).toFixed(1) + 'px');
      }
    }
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
  window.addEventListener('resize', frame);
  frame();

  /* ---------- Появление при прокрутке ---------- */
  const reveal = $$('[data-reveal]');
  if (reduce || !('IntersectionObserver' in window)) reveal.forEach((n) => n.classList.add('is-in'));
  else {
    const io = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting) {
        e.target.classList.add('is-in'); io.unobserve(e.target);
        setTimeout(() => { e.target.style.transitionDelay = ''; }, 1500); // задержка нужна только для появления, не для наведения
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    for (const n of reveal) {
      const sibs = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.hasAttribute('data-reveal')) : [n];
      n.style.transitionDelay = (Math.min(sibs.indexOf(n), 7) * 70) + 'ms';
      io.observe(n);
    }
  }

  /* ---------- Карусели со стрелками ---------- */
  $$('[data-rail]').forEach((rail) => {
    const track = $('.rail__track', rail);
    const prev = $('[data-rail-prev]', rail);
    const next = $('[data-rail-next]', rail);
    if (!track || !prev || !next) return;
    const step = () => Math.max(240, track.clientWidth * 0.82);
    const state = () => { prev.disabled = track.scrollLeft < 8; next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8; };
    prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: reduce ? 'auto' : 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: reduce ? 'auto' : 'smooth' }));
    track.addEventListener('scroll', state, { passive: true });
    window.addEventListener('resize', state);
    state();
  });

  /* ---------- Выезжающая корзина ---------- */
  const mini = $('#minicart');
  if (mini) {
    const body = $('[data-mini-body]', mini);
    const count = $('[data-mini-count]', mini);
    const sum = $('[data-mini-sum]', mini);
    const free = $('[data-mini-free]', mini);
    const foot = $('.minicart__foot', mini);
    let lastFocus = null;
    const isOpen = () => mini.classList.contains('is-open');
    function setOpen(open) {
      mini.classList.toggle('is-open', open);
      mini.setAttribute('aria-hidden', String(!open));
      root.classList.toggle('mini-open', open);
      if (open) { lastFocus = document.activeElement; const c = $('.minicart__head .iconbtn', mini); if (c) c.focus(); } else if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    }
    function setBadge(n) {
      $$('[data-cart-count]').forEach((b) => { b.textContent = n || ''; b.classList.toggle('is-empty', !n); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); });
    }
    async function api(path, form) {
      const r = await fetch(path, form ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fetch': '1', accept: 'application/json' }, body: new URLSearchParams(form) } : { headers: { accept: 'application/json' } });
      return r.json();
    }
    function render(d) {
      body.replaceChildren();
      count.textContent = d.count ? String(d.count) : '';
      foot.hidden = !d.lines.length;
      if (!d.lines.length) {
        const e = el('div', 'minicart__empty');
        e.appendChild(el('b', null, 'Корзина пуста'));
        e.appendChild(el('p', null, 'Выберите пару в каталоге, размер и цену подскажем на странице модели.'));
        const a = el('a', 'btn', 'Перейти в каталог'); a.href = '/catalog'; e.appendChild(a);
        body.appendChild(e);
      }
      for (const l of d.lines) {
        const row = el('article', 'mline' + (l.out ? ' is-out' : ''));
        const img = el('a', 'mline__img'); img.href = l.href;
        if (l.img) { const i = el('img'); i.src = l.img; i.alt = ''; i.width = 120; i.height = 120; i.loading = 'lazy'; img.appendChild(i); }
        const info = el('div', 'mline__info');
        const t = el('a', 'mline__title', l.title); t.href = l.href;
        info.appendChild(t);
        if (l.meta) info.appendChild(el('p', 'mline__meta', l.meta));
        if (l.out) info.appendChild(el('p', 'mline__warn', 'Нет в наличии'));
        else {
          const step = el('div', 'stepper');
          const minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'Меньше');
          const q = el('span', null, String(l.qty));
          const plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'Больше'); plus.disabled = l.qty >= l.max;
          minus.addEventListener('click', () => change(l.pid, l.qty - 1));
          plus.addEventListener('click', () => change(l.pid, l.qty + 1));
          step.append(minus, q, plus);
          info.appendChild(step);
        }
        const side = el('div', 'mline__side');
        side.appendChild(el('b', null, rub(l.sum)));
        const rm = el('button', 'mline__rm', 'Убрать'); rm.type = 'button'; rm.addEventListener('click', () => change(l.pid, 0));
        side.appendChild(rm);
        row.append(img, info, side);
        body.appendChild(row);
      }
      sum.textContent = rub(d.subtotal);
      if (d.free && d.lines.length) {
        free.hidden = false;
        $('[data-mini-free-text]', mini).textContent = d.free.left > 0 ? 'До бесплатной доставки: ' + rub(d.free.left) : 'Бесплатная доставка включена';
        $('[data-mini-free-fill]', mini).style.setProperty('--w', Math.min(100, d.free.pct) + '%');
        free.classList.toggle('is-done', d.free.left <= 0);
      } else free.hidden = true;
      setBadge(d.count);
    }
    async function refresh() { try { render(await api('/api/cart')); } catch (e) { /* оставим как есть */ } }
    async function change(pid, qty) {
      body.classList.add('is-busy');
      try { await api('/cart/update', { pid, qty }); } catch (e) { /* ниже перечитаем корзину */ }
      await refresh();
      body.classList.remove('is-busy');
    }
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-mini-close]')) return setOpen(false);
      const cb = e.target.closest('.cartbtn');
      if (cb && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !/^\/(cart|checkout)/.test(location.pathname)) { e.preventDefault(); refresh(); setOpen(true); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false); });
    document.addEventListener('cart:changed', async (e) => { await refresh(); if (e.detail && e.detail.open) setOpen(true); });
  }
})();
