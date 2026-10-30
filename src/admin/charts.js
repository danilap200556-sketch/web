'use strict';
// Графики для админки: серверный SVG без библиотек. Цвета берутся из CSS-переменных (.s1, .s2 ... в admin.css),
// поэтому тёмная тема работает без перерисовки. Подсказки при наведении рисует admin.js по данным в data-tips.
const { html } = require('../html');
const { num } = require('../util');

const NB = ' ';

// «Красивый» верх шкалы и шаг: 0..nice с 4-5 делениями
function niceScale(max) {
  if (!(max > 0)) return { max: 4, step: 1 };
  const exp = Math.pow(10, Math.floor(Math.log10(max / 4)));
  const f = max / 4 / exp;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  return { max: Math.ceil(max / step) * step, step };
}

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',').replace(/,0$/, '') + NB + 'млн';
  if (a >= 1e4) return Math.round(n / 1e3) + NB + 'тыс.';
  return num(n);
}

const monthShort = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const dayLabel = (iso) => monthShort.format(new Date(iso + 'T00:00:00Z')).replace('.', '');
const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' });
const dayLong = (iso) => `${dayLabel(iso)}, ${weekday.format(new Date(iso + 'T00:00:00Z'))}`;

const W = 760;
const H = 252;
const M = { l: 52, r: 14, t: 14, b: 30 };
const PW = W - M.l - M.r;
const PH = H - M.t - M.b;

function frame(scale, labels, fmtY, xAt) {
  const ticks = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) ticks.push(v);
  const y = (v) => M.t + PH - (v / scale.max) * PH;
  const every = Math.max(1, Math.ceil(labels.length / 8));
  return html`<g class="grid">${ticks.map((v) => html`<line x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`)}</g>
    <g class="ytick">${ticks.map((v) => html`<text x="${M.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtY(v)}</text>`)}</g>
    <g class="xtick">${labels.map((l, i) => (i % every === 0 || i === labels.length - 1) && (labels.length - 1 - i >= every * 0.6 || i === labels.length - 1) ? html`<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${dayLabel(l)}</text>` : '')}</g>`;
}

const attrJson = (o) => JSON.stringify(o);

// ---- Столбцы: одна серия (title графика называет её, легенда не нужна) ----
function barChart({ labels, values, name, fmt, fmtY = compact, cls = 's1', title }) {
  const scale = niceScale(Math.max(...values, 0));
  const n = labels.length;
  const slot = PW / n;
  const bw = Math.max(2, Math.min(24, slot - 2));
  const xc = (i) => M.l + slot * i + slot / 2;
  const y = (v) => M.t + PH - (v / scale.max) * PH;
  const r = Math.min(4, bw / 2);
  const bars = values.map((v, i) => {
    if (!(v > 0)) return '';
    const x = xc(i) - bw / 2;
    const top = y(v);
    const hgt = M.t + PH - top;
    const rr = Math.min(r, hgt);
    // скругление только на конце, у базовой линии угол прямой
    const d = `M${x.toFixed(1)} ${(M.t + PH).toFixed(1)}V${(top + rr).toFixed(1)}a${rr} ${rr} 0 0 1 ${rr} -${rr}H${(x + bw - rr).toFixed(1)}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${(M.t + PH).toFixed(1)}Z`;
    return html`<path class="bar ${cls}" data-i="${i}" d="${d}"/>`;
  });
  const tips = labels.map((l, i) => ({ t: dayLong(l), rows: [{ k: name, v: fmt(values[i]), c: cls }] }));
  return html`<figure class="chart" aria-label="${title}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" data-tips="${attrJson(tips)}" data-x0="${M.l}" data-slot="${slot}" data-w="${W}" data-mode="bar">
      ${frame(scale, labels, fmtY, xc)}
      ${bars}
      <line class="cross" y1="${M.t}" y2="${M.t + PH}" x1="0" x2="0" hidden/>
    </svg>
  </figure>`;
}

// ---- Линии: 1-3 серии. Подпись «Название значение» на конце, если линии не сливаются; легенда всегда при ≥2 сериях ----
function lineChart({ labels, series, title, partialLast = false }) {
  const max = Math.max(...series.flatMap((s) => s.values), 0);
  const scale = niceScale(max);
  const n = labels.length;
  const xAt = (i) => M.l + (n === 1 ? PW / 2 : (PW * i) / (n - 1));
  const y = (v) => M.t + PH - (v / scale.max) * PH;
  const lines = series.map((s, k) => {
    const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${y(v).toFixed(1)}`);
    // Неполный последний день (сегодня) рисуем отдельным пунктирным отрезком: резкий спад в конце - не падение продаж
    const cut = partialLast && n > 2 ? n - 1 : n;
    const area = k === 0 ? html`<polygon class="area ${s.cls}" points="${xAt(0).toFixed(1)},${M.t + PH} ${pts.slice(0, cut).join(' ')} ${xAt(cut - 1).toFixed(1)},${M.t + PH}"/>` : '';
    const last = s.values[n - 1];
    return html`${area}<polyline class="line ${s.cls}" points="${pts.slice(0, cut).join(' ')}"/>
      ${cut < n ? html`<polyline class="line line--partial ${s.cls}" points="${pts.slice(cut - 1).join(' ')}"/>` : ''}
      <circle class="dot ${s.cls}" cx="${xAt(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4.5"/>`;
  });
  const tips = labels.map((l, i) => ({ t: dayLong(l), rows: series.map((s) => ({ k: s.name, v: num(s.values[i]), c: s.cls })) }));
  return html`<figure class="chart" aria-label="${title}">
    ${series.length > 1 ? html`<div class="legend">${series.map((s) => html`<span><i class="key ${s.cls}"></i>${s.name}</span>`)}</div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}" data-tips="${attrJson(tips)}" data-x0="${M.l}" data-slot="${n === 1 ? PW : PW / (n - 1)}" data-w="${W}" data-mode="line" data-first="${M.l}">
      ${frame(scale, labels, compact, xAt)}
      ${lines}
      <line class="cross" y1="${M.t}" y2="${M.t + PH}" x1="0" x2="0" hidden/>
    </svg>
  </figure>`;
}

// ---- Горизонтальные полосы: категория -> значение на конце ----
function hBars({ items, fmt = num, cls = 's1', total, sub }) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  const sum = total ?? items.reduce((a, i) => a + i.value, 0);
  return html`<ul class="hbars">${items.map((i) => html`<li data-tip="${attrJson({ t: i.label, rows: [{ k: sub || 'Значение', v: fmt(i.value), c: i.cls || cls }, ...(sum ? [{ k: 'Доля', v: Math.round((i.value / sum) * 100) + '%', c: i.cls || cls }] : [])] })}">
    <span class="hbars__l">${i.label}</span><b class="hbars__v">${fmt(i.value)}</b>
    <svg class="hbars__bar" width="100%" height="8" aria-hidden="true"><rect class="hbars__bg" width="100%" height="8" rx="4"/><rect class="${i.cls || cls}" width="${Math.max(i.value > 0 ? 1.2 : 0, (i.value / max) * 100).toFixed(1)}%" height="8" rx="4"/></svg>
  </li>`)}</ul>`;
}

// ---- Воронка: порядковые шаги одного оттенка от светлого к тёмному ----
function funnel(steps) {
  const top = Math.max(steps[0].value, 1);
  return html`<ol class="funnel">${steps.map((s, i) => {
    const prev = i ? steps[i - 1].value : null;
    return html`<li data-tip="${attrJson({ t: s.label, rows: [{ k: 'Визитов', v: num(s.value), c: `f${i + 1}` }, { k: 'От всех визитов', v: Math.round((s.value / top) * 100) + '%', c: `f${i + 1}` }, ...(prev ? [{ k: 'От прошлого шага', v: prev ? Math.round((s.value / prev) * 100) + '%' : '-', c: `f${i + 1}` }] : [])] })}">
      <span class="funnel__l">${s.label}</span><b>${num(s.value)}</b>
      <span class="funnel__p">${prev ? Math.round((s.value / prev) * 100) + '% от прошлого' : 'все визиты'}</span>
      <svg class="funnel__bar" width="100%" height="14" aria-hidden="true"><rect class="f${i + 1}" width="${Math.max(s.value > 0 ? 0.8 : 0, (s.value / top) * 100).toFixed(1)}%" height="14" rx="4"/></svg>
    </li>`;
  })}</ol>`;
}

// ---- Одна целая, разбитая на части (тонкая полоса + легенда с числами) ----
function segBar({ parts, fmt = num }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return html`<p class="muted">Пока нет данных</p>`;
  let x = 0;
  const gap = 0.6;
  const rects = parts.filter((p) => p.value > 0).map((p, i, arr) => {
    const w = (p.value / total) * 100;
    const out = html`<rect class="${p.cls}" x="${(x + (i ? gap / 2 : 0)).toFixed(2)}%" width="${Math.max(0.4, w - (i ? gap / 2 : 0) - (i < arr.length - 1 ? gap / 2 : 0)).toFixed(2)}%" height="10" rx="5" data-tip="${attrJson({ t: p.label, rows: [{ k: 'Значение', v: fmt(p.value), c: p.cls }, { k: 'Доля', v: Math.round((p.value / total) * 100) + '%', c: p.cls }] })}"/>`;
    x += w;
    return out;
  });
  return html`<div class="seg">
    <svg width="100%" height="10" role="img" aria-label="${parts.map((p) => `${p.label}: ${fmt(p.value)}`).join(', ')}">${rects}</svg>
    <ul class="legend legend--list">${parts.map((p) => html`<li><i class="key ${p.cls}"></i><span>${p.label}</span><b>${fmt(p.value)}</b><em>${Math.round((p.value / total) * 100)}%</em></li>`)}</ul>
  </div>`;
}

// ---- Мини-график для плитки показателя: 12-ти значений, последнее выделено ----
function sparkline(values) {
  const n = values.length;
  if (n < 2) return '';
  const max = Math.max(...values, 1);
  const w = 96;
  const h = 28;
  const pts = values.map((v, i) => [(w * i) / (n - 1), h - 3 - (v / max) * (h - 8)]);
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ')}"/><circle cx="${pts[n - 1][0]}" cy="${pts[n - 1][1].toFixed(1)}" r="3"/></svg>`;
}

// Таблица-двойник графика: те же числа без наведения
function tableView({ head, rows }) {
  return html`<details class="tableview"><summary>Показать таблицей</summary>
    <div class="tablewrap"><table class="table table--compact"><thead><tr>${head.map((h, i) => html`<th class="${i ? 'num' : ''}">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => html`<td class="${i ? 'num' : ''}">${c}</td>`)}</tr>`)}</tbody></table></div></details>`;
}

module.exports = { barChart, lineChart, hBars, funnel, segBar, sparkline, tableView, compact, dayLabel, dayLong };
