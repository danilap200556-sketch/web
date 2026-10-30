'use strict';

const NBSP = ' ';

// 12990 -> "12 990 ₽"
function rub(n) {
  const v = Math.round(Number(n) || 0);
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + NBSP + '₽';
}
function num(n) {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Телефон -> 7XXXXXXXXXX (только РФ/КЗ); пусто, если не похоже на номер.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length === 11 && d[0] === '7' ? d : '';
}
function formatPhone(p) {
  const d = String(p || '');
  if (d.length !== 11) return d;
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '')) && s.length <= 120;
}

// Строка из формы: обрезаем, схлопываем пробелы, ограничиваем длину.
function str(v, max = 200) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function dateFmt(tz) {
  const dt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const dtt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const short = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'short' });
  return {
    date: (d) => (d ? dt.format(new Date(d)) : ''),
    dateTime: (d) => (d ? dtt.format(new Date(d)).replace(',', '') : ''),
    short: (d) => (d ? short.format(new Date(d)).replace('.', '') : ''),
  };
}

module.exports = { rub, num, plural, normalizePhone, formatPhone, isEmail, str, clampInt, slugify, dateFmt, NBSP };
