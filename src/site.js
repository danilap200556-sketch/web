'use strict';
// Подвал сайта и карта: соцсети, значки оплаты и доставки, Яндекс Карта, разметка текстовых страниц («О нас», соглашения).
// Всё заполняется в админке: «Настройки» → «Подвал сайта и карта», «Страницы».
const { html, raw, esc } = require('./html');

// Соцсети: адрес принимаем только https и только с домена самой сети - в подвал не попадёт чужая или опасная ссылка
const SOCIALS = [
  { key: 'vk', title: 'ВКонтакте', icon: 'vk', hosts: ['vk.com', 'vk.ru', 'm.vk.com'] },
  { key: 'telegram', title: 'Telegram', icon: 'send', hosts: ['t.me', 'telegram.me'] },
  { key: 'youtube', title: 'YouTube', icon: 'youtube', hosts: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'] },
  { key: 'rutube', title: 'RUTUBE', icon: 'rutube', hosts: ['rutube.ru'] },
  { key: 'dzen', title: 'Дзен', icon: 'dzen', hosts: ['dzen.ru'] },
  { key: 'whatsapp', title: 'WhatsApp', icon: 'whatsapp', hosts: ['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com'] },
];

function socialUrl(key, value) {
  const s = SOCIALS.find((x) => x.key === key);
  let v = String(value || '').trim();
  if (!s || !v) return '';
  if (key === 'telegram' && /^@[A-Za-z0-9_]{4,64}$/.test(v)) v = `https://t.me/${v.slice(1)}`;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  let u;
  try { u = new URL(v); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!s.hosts.includes(u.hostname.toLowerCase())) return '';
  u.protocol = 'https:';
  return u.toString();
}

function socialList(s) {
  const so = (s && s.socials) || {};
  return SOCIALS.map((x) => ({ ...x, url: socialUrl(x.key, so[x.key]) })).filter((x) => x.url);
}

// Значки оплаты и доставки внизу подвала (рисуются своими стилями, без чужих картинок)
const BADGES = [
  { key: 'mir', title: 'МИР', group: 'pay' },
  { key: 'visa', title: 'VISA', group: 'pay' },
  { key: 'mastercard', title: 'Mastercard', group: 'pay' },
  { key: 'sbp', title: 'СБП', group: 'pay' },
  { key: 'yoomoney', title: 'ЮMoney', group: 'pay' },
  { key: 'split', title: 'Сплит', group: 'pay' },
  { key: 'dolyami', title: 'Долями', group: 'pay' },
  { key: 'pochta', title: 'Почта России', group: 'ship' },
  { key: 'ems', title: 'EMS', group: 'ship' },
  { key: 'cdek', title: 'СДЭК', group: 'ship' },
  { key: 'boxberry', title: 'Boxberry', group: 'ship' },
  { key: 'yandex', title: 'Яндекс Доставка', group: 'ship' },
];
const DEFAULT_BADGES = ['mir', 'visa', 'mastercard', 'sbp', 'pochta', 'cdek', 'boxberry'];

function badgeHtml(key) {
  const b = BADGES.find((x) => x.key === key);
  if (!b) return '';
  if (key === 'mastercard') return html`<li class="pbadge pbadge--mastercard" title="Mastercard"><i></i><i></i><span class="sr">Mastercard</span></li>`;
  if (key === 'mir') return html`<li class="pbadge pbadge--mir" title="МИР">МИР</li>`;
  if (key === 'sbp') return html`<li class="pbadge pbadge--sbp" title="СБП"><i></i>СБП</li>`;
  return html`<li class="pbadge pbadge--${key}" title="${b.title}">${b.title}</li>`;
}

// ---------- Яндекс Карта ----------
// В админке можно вписать: адрес текстом, координаты («55.743800, 37.500500» - как копирует Яндекс Карты),
// ссылку с Яндекс Карт (берутся ll/pt/z) или код из конструктора карт (um=constructor:...). Пусто - адрес магазина.
const WIDGET = 'https://yandex.ru/map-widget/v1/';
const MAPS = 'https://yandex.ru/maps/';

function mapFor(s) {
  const m = (s && s.map) || {};
  const zoom = Math.min(19, Math.max(3, parseInt(m.zoom, 10) || 16));
  const q = String(m.query || '').trim() || String((s && s.address) || '').trim();
  if (!q || m.show === 'off') return null;
  const cons = /um=constructor(?:%3A|:)([A-Za-z0-9_-]{10,200})/.exec(q);
  if (cons) {
    const um = `constructor%3A${cons[1]}`;
    return { src: `${WIDGET}?um=${um}&source=constructor`, open: `${MAPS}?um=${um}&source=constructorLink`, route: '', zoom };
  }
  let lat = null, lon = null, z = zoom;
  const c = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q);
  if (c) { lat = Number(c[1]); lon = Number(c[2]); }
  else if (/^https?:\/\/(?:www\.)?yandex\.(?:ru|com)\/maps/i.test(q)) {
    try {
      const u = new URL(q);
      const p = (u.searchParams.get('pt') || u.searchParams.get('ll') || '').split(',');
      if (p.length >= 2) { lon = Number(p[0]); lat = Number(p[1]); }
      if (u.searchParams.get('z')) z = Math.min(19, Math.max(3, parseInt(u.searchParams.get('z'), 10) || zoom));
    } catch (e) { /* не ссылка - ниже как адрес */ }
  }
  if (lat !== null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const ll = `${lon}%2C${lat}`;
    return { src: `${WIDGET}?ll=${ll}&z=${z}&pt=${ll}%2Cpm2dgl`, open: `${MAPS}?pt=${ll}&z=${z}&l=map`, route: `${MAPS}?rtext=~${lat}%2C${lon}&rtt=auto`, zoom: z };
  }
  if (/^https?:/i.test(q)) return null; // ссылка не с Яндекс Карт или без координат
  const t = encodeURIComponent(q);
  return { src: `${WIDGET}?text=${t}&z=${zoom}`, open: `${MAPS}?text=${t}`, route: `${MAPS}?rtext=~${t}&rtt=auto`, zoom };
}

// ---------- Текст страниц: абзацы, «## заголовок», «- пункт», **жирный**, ссылки [текст](https://...) ----------
function inline(text) {
  // сначала экранируем всё, потом разрешаем только жирный и ссылки на https и свои страницы
  const e = esc(text);
  return e
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(((?:https:\/\/|\/(?!\/))[^)\s"'<>]*)\)/g, (m, t, href) => `<a href="${href}"${href.startsWith('/') ? '' : ' rel="noopener" target="_blank"'}>${t}</a>`);
}

function renderText(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); list = []; }
  };
  for (const l of lines) {
    const t = l.trim();
    if (!t) { flush(); continue; }
    const h = /^(#{2,3})\s+(.+)$/.exec(t);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = /^[-*•]\s+(.+)$/.exec(t);
    if (li) { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } list.push(li[1]); continue; }
    if (list.length) { out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); list = []; }
    para.push(t);
  }
  flush();
  return raw(out.join('\n'));
}

module.exports = { SOCIALS, socialUrl, socialList, BADGES, DEFAULT_BADGES, badgeHtml, mapFor, renderText };
