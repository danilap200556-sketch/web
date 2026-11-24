/* Оформление v4 «уличный магазин»: сообщения в верхней полосе, баннер-слайдер на главной, избранное.
   Без библиотек. Без JS всё читается: баннер листается пальцем (scroll-snap), сердечки просто не работают.
   При prefers-reduced-motion ничего не сменяется само. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Верхняя полоса: сообщения по очереди, стрелки листают ---------- */
  const ticker = $('[data-ticker]');
  if (ticker) {
    const msgs = $$('.announce__msg', ticker);
    let cur = 0, timer = 0;
    const show = (i) => {
      cur = (i + msgs.length) % msgs.length;
      msgs.forEach((m, k) => m.classList.toggle('is-on', k === cur));
      clearTimeout(timer);
      if (!reduce && msgs.length > 1) timer = setTimeout(() => show(cur + 1), 4500);
    };
    const prev = $('[data-ticker-prev]', ticker);
    const next = $('[data-ticker-next]', ticker);
    if (prev) prev.addEventListener('click', () => show(cur - 1));
    if (next) next.addEventListener('click', () => show(cur + 1));
    if (msgs.length) show(0);
  }

  /* ---------- Баннер-слайдер: дорожка с прокруткой, стрелки, точки, автосмена с паузой ---------- */
  const banner = $('[data-banner]');
  if (banner) {
    const track = $('[data-banner-track]', banner);
    const slides = $$('[data-banner-slide]', banner);
    const dots = $$('[data-banner-dot]', banner);
    const MS = 6500;
    let cur = 0, timer = 0, paused = false;
    const go = (i, smooth = true) => {
      const n = (i + slides.length) % slides.length;
      track.scrollTo({ left: slides[n].offsetLeft - track.offsetLeft, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    };
    const mark = (i) => {
      if (i === cur && dots[i] && dots[i].classList.contains('is-active')) return;
      cur = i;
      slides.forEach((sl, k) => { sl.classList.toggle('is-active', k === i); sl.toggleAttribute('inert', k !== i); });
      dots.forEach((d, k) => { d.classList.toggle('is-active', k === i); d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
      // перезапуск заполнения точки
      const d = dots[i]; if (d) { d.classList.remove('is-active'); void d.offsetWidth; d.classList.add('is-active'); }
      schedule();
    };
    const schedule = () => { clearTimeout(timer); if (!paused && !reduce && slides.length > 1) timer = setTimeout(() => go(cur + 1), MS); };
    let raf = 0;
    track.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; mark(Math.round(track.scrollLeft / Math.max(1, track.clientWidth))); });
    }, { passive: true });
    const prev = $('[data-banner-prev]', banner);
    const next = $('[data-banner-next]', banner);
    if (prev) prev.addEventListener('click', () => go(cur - 1));
    if (next) next.addEventListener('click', () => go(cur + 1));
    dots.forEach((d) => d.addEventListener('click', () => go(Number(d.dataset.bannerDot) || 0)));
    const pause = (on) => { paused = on; banner.classList.toggle('is-paused', on); if (on) clearTimeout(timer); else schedule(); };
    banner.addEventListener('mouseenter', () => pause(true));
    banner.addEventListener('mouseleave', () => pause(false));
    banner.addEventListener('focusin', () => pause(true));
    banner.addEventListener('focusout', () => pause(false));
    document.addEventListener('visibilitychange', () => pause(document.hidden));
    banner.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); }
    });
    window.addEventListener('resize', () => go(cur, false));
    if (slides.length) mark(0);
  }

  /* ---------- Избранное: cookie fav = адреса моделей через «.», сервер по нему собирает /favorites ---------- */
  const NAME = 'fav';
  const read = () => {
    const m = document.cookie.match(/(?:^|;\s*)fav=([^;]*)/);
    return m ? m[1].split('.').filter((x) => /^[a-z0-9-]{1,120}$/.test(x)) : [];
  };
  const write = (list) => {
    const v = list.slice(-60).join('.');
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = v ? `${NAME}=${v}; Path=/; Max-Age=31536000; SameSite=Lax${secure}` : `${NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  };
  const paint = () => {
    const list = read();
    $$('[data-fav]').forEach((b) => {
      const on = list.includes(b.dataset.fav);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
    });
    $$('[data-fav-count]').forEach((c) => { c.textContent = list.length || ''; c.classList.toggle('is-empty', !list.length); });
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-fav]');
    if (!b) return;
    e.preventDefault();
    const slug = b.dataset.fav;
    const list = read();
    const i = list.indexOf(slug);
    if (i >= 0) list.splice(i, 1); else list.push(slug);
    write(list);
    paint();
    if (i < 0 && !reduce) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    $$('[data-fav-count]').forEach((c) => { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); });
  });
  // вернулись кнопкой «назад» - состояние могло измениться на другой странице
  window.addEventListener('pageshow', paint);
  paint();
})();
