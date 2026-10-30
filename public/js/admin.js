/* Админка: подсказки на графиках, меню на телефоне, клики по строкам таблиц. Без библиотек. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const tip = $('#tip');

  // Содержимое подсказки собирается через textContent: названия приходят из базы
  function fillTip(data) {
    tip.replaceChildren();
    const t = document.createElement('div'); t.className = 'tip__t'; t.textContent = data.t; tip.appendChild(t);
    data.rows.forEach((r) => {
      const row = document.createElement('div'); row.className = 'tip__r ' + (r.c || '');
      const key = document.createElement('i'); const k = document.createElement('span'); k.textContent = r.k;
      const v = document.createElement('b'); v.textContent = r.v;
      row.append(key, k, v); tip.appendChild(row);
    });
  }
  function placeTip(x, y) {
    tip.hidden = false;
    const w = tip.offsetWidth; const h = tip.offsetHeight;
    let left = x + 14; let top = y - h - 12;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 18;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = top + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // Графики по дням: перекрестие находит ближайший день, одна подсказка со всеми рядами
  $$('svg[data-tips]').forEach((svg) => {
    const tips = JSON.parse(svg.dataset.tips);
    const mode = svg.dataset.mode;
    const x0 = parseFloat(svg.dataset.x0); const slot = parseFloat(svg.dataset.slot); const W = parseFloat(svg.dataset.w);
    const cross = $('.cross', svg);
    const bars = $$('.bar', svg);
    const handle = (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      let i = mode === 'bar' ? Math.floor((x - x0) / slot) : Math.round((x - x0) / slot);
      i = Math.max(0, Math.min(tips.length - 1, i));
      if (x < x0 - 4 || x > W) { leave(); return; }
      fillTip(tips[i]);
      if (cross) {
        const cx = mode === 'bar' ? x0 + slot * i + slot / 2 : x0 + slot * i;
        cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.hidden = false;
      }
      bars.forEach((b) => b.classList.toggle('is-dim', Number(b.dataset.i) !== i));
      placeTip(e.clientX, e.clientY);
    };
    const leave = () => { hideTip(); if (cross) cross.hidden = true; bars.forEach((b) => b.classList.remove('is-dim')); };
    svg.addEventListener('pointermove', handle);
    svg.addEventListener('pointerleave', leave);
    svg.addEventListener('pointerdown', handle);
  });

  // Полосы, воронка, сегменты: подсказка на самом элементе
  $$('[data-tip]').forEach((el) => {
    const data = JSON.parse(el.dataset.tip);
    el.addEventListener('pointermove', (e) => { fillTip(data); placeTip(e.clientX, e.clientY); });
    el.addEventListener('pointerleave', hideTip);
  });

  // Меню на телефоне
  const side = $('#side');
  const tg = $('[data-side-toggle]');
  if (side && tg) {
    tg.addEventListener('click', () => side.classList.toggle('is-open'));
    document.addEventListener('click', (e) => { if (side.classList.contains('is-open') && !side.contains(e.target) && !tg.contains(e.target)) side.classList.remove('is-open'); });
  }

  // Строки таблиц открываются по клику (ссылки внутри работают как обычно)
  $$('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button, input, select, textarea')) location.href = tr.dataset.href; }));

  // Выпадающие списки в фильтрах применяются сразу
  $$('select[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form.submit()));
})();
