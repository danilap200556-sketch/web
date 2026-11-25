'use strict';
// Размерные сетки. Обувь: таблицы по брендам (EU, US муж., US жен., UK, длина стопы в см), одежда: общая таблица мерок.
// Nike и Jordan - данные с официальной страницы nike.com/size-fit/mens-footwear. Таблицы adidas и New Balance составлены по их
// опубликованным сеткам (страницы брендов закрыты для автоматического чтения, поэтому сверьте их при случае). Остальные бренды
// получают универсальную таблицу с пометкой: размеры у каждого бренда могут отличаться на пол-размера.
const { html, raw } = require('./html');

const zip = (eu, usM, usW, uk, cm) => eu.map((e, i) => ({ eu: e, usM: usM[i], usW: usW[i], uk: uk[i], cm: cm[i] }));
const w = (s) => s.split(/\s+/);

const NIKE_ROWS = zip(
  w('35.5 36 36.5 37.5 38 38.5 39 40 40.5 41 42 42.5 43 44 44.5 45 45.5 46 47 47.5 48 48.5 49 49.5'),
  w('3.5 4 4.5 5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 13.5 14 14.5 15'),
  w('5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 13.5 14 14.5 15 15.5 16 16.5'),
  w('3 3.5 4 4.5 5 5.5 6 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 13.5 14'),
  w('22.5 23 23.5 23.5 24 24 24.5 25 25.5 26 26.5 27 27.5 28 28.5 29 29.5 30 30.5 31 31.5 32 32.5 33'),
);

const ADIDAS_ROWS = zip(
  ['36', '36 2/3', '37 1/3', '38', '38 2/3', '39 1/3', '40', '40 2/3', '41 1/3', '42', '42 2/3', '43 1/3', '44', '44 2/3', '45 1/3', '46', '46 2/3', '47 1/3', '48'],
  w('4 4.5 5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13'),
  w('5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 13.5 14'),
  w('3.5 4 4.5 5 5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5'),
  w('22.1 22.5 23 23.3 23.8 24.2 24.7 25.1 25.5 26 26.5 27 27.5 28 28.5 29 29.4 29.9 30.4'),
);

const NB_ROWS = zip(
  w('38.5 39.5 40 40.5 41.5 42 42.5 43 44 44.5 45 45.5 46.5 47.5'),
  w('6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 13'),
  w('7.5 8 8.5 9 9.5 10 10.5 11 11.5 12 12.5 13 13.5 14.5'),
  w('5.5 6 6.5 7 7.5 8 8.5 9 9.5 10 10.5 11 11.5 12.5'),
  w('24 24.5 25 25.5 26 26.5 27 27.5 28 28.5 29 29.5 30 31'),
);

const CHARTS = [
  { key: 'nike', title: 'Nike и Jordan', source: 'по данным nike.com', rows: NIKE_ROWS, note: 'Jordan и Converse by Nike выбирайте по этой же таблице. Если стопа широкая или между размерами, берите больший.' },
  { key: 'adidas', title: 'adidas и Yeezy', source: 'по опубликованной сетке adidas', rows: ADIDAS_ROWS, note: 'У adidas размеры EU бывают дробными (2/3 и 1/3). Женский US на единицу больше мужского. Yeezy часто маломерят: берите на размер больше.' },
  { key: 'newbalance', title: 'New Balance', source: 'по опубликованной сетке New Balance', rows: NB_ROWS, note: 'У New Balance женский US на 1,5 больше мужского. Модели бывают разной полноты (D, 2E): таблица для обычной.' },
  { key: 'universal', title: 'Универсальная таблица', source: 'ориентир для других брендов', rows: NIKE_ROWS, note: '' },
];

// Одежда: ориентировочные мерки (у брендов крой разный, поэтому сверяйтесь с замерами на странице товара или спросите менеджера)
const APPAREL = {
  women: [
    { intl: 'XS', ru: '42', eu: '34', chest: '80-84', waist: '60-64', hip: '86-90' }, { intl: 'S', ru: '44', eu: '36', chest: '84-88', waist: '64-68', hip: '90-94' },
    { intl: 'M', ru: '46', eu: '38', chest: '88-92', waist: '68-72', hip: '94-98' }, { intl: 'L', ru: '48', eu: '40', chest: '92-96', waist: '72-76', hip: '98-102' },
    { intl: 'XL', ru: '50', eu: '42', chest: '96-100', waist: '76-80', hip: '102-106' }, { intl: 'XXL', ru: '52', eu: '44', chest: '100-104', waist: '80-84', hip: '106-110' },
  ],
  men: [
    { intl: 'XS', ru: '44', eu: '44', chest: '84-88', waist: '70-74', hip: '90-94' }, { intl: 'S', ru: '46', eu: '46', chest: '88-92', waist: '76-80', hip: '92-96' },
    { intl: 'M', ru: '48', eu: '48', chest: '96-100', waist: '84-88', hip: '98-102' }, { intl: 'L', ru: '50', eu: '50', chest: '104-108', waist: '92-96', hip: '104-108' },
    { intl: 'XL', ru: '52', eu: '52', chest: '112-116', waist: '100-104', hip: '110-114' }, { intl: 'XXL', ru: '54', eu: '54', chest: '120-124', waist: '108-112', hip: '116-120' },
  ],
};

// «42», «42.5», «38 2/3» -> число; всё остальное (M, XL) - NaN
function parseEu(s) {
  const t = String(s ?? '').trim().replace(',', '.');
  const m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

function chartFor(brand) {
  const b = String(brand || '').toLowerCase();
  if (/nike|jordan/.test(b)) return CHARTS[0];
  if (/adidas|yeezy/.test(b)) return CHARTS[1];
  if (/new balance|(^|[^a-z])nb([^a-z]|$)/.test(b)) return CHARTS[2];
  const u = CHARTS[3];
  return { ...u, note: `У ${brand || 'этого бренда'} размеры могут отличаться на пол-размера от таблицы: ориентируйтесь на длину стопы в сантиметрах, а при сомнениях спросите менеджера.` };
}

function shoeTable(chart, have = []) {
  const mine = new Set(have.map(parseEu).filter((x) => Number.isFinite(x)).map((x) => Math.round(x * 100)));
  return html`<div class="sizetable"><table><thead><tr><th>EU</th><th>US (муж.)</th><th>US (жен.)</th><th>UK</th><th>CM</th></tr></thead><tbody>
    ${chart.rows.map((r) => html`<tr${mine.has(Math.round(parseEu(r.eu) * 100)) ? raw(' class="is-have"') : ''}><th scope="row">${r.eu}</th><td>${r.usM}</td><td>${r.usW}</td><td>${r.uk}</td><td>${r.cm}</td></tr>`)}
  </tbody></table></div>`;
}

function apparelTable(rows) {
  return html`<div class="sizetable"><table><thead><tr><th>Международный</th><th>RU</th><th>EU</th><th>Грудь, см</th><th>Талия, см</th><th>Бёдра, см</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><th scope="row">${r.intl}</th><td>${r.ru}</td><td>${r.eu}</td><td>${r.chest}</td><td>${r.waist}</td><td>${r.hip}</td></tr>`)}
  </tbody></table></div>`;
}

const HOW_TO = 'Встаньте на лист бумаги, отметьте самую дальнюю точку большого пальца и пятку, измерьте расстояние линейкой в сантиметрах. Лучше мерить вечером и прибавить 0,5-1 см запаса.';

// Раскрывающийся блок в карточке товара: обувь - таблица бренда с подсветкой размеров в наличии, одежда - мерки; иначе пусто
function guideBlock({ brand, dept, sizes = [] }) {
  if (dept === 'shoes') {
    const chart = chartFor(brand);
    return html`<details class="acc sizeguide"><summary>Таблица размеров</summary><div class="acc__body">
      <p><b>${chart.title}</b> <span class="muted">· ${chart.source}</span></p>
      ${shoeTable(chart, sizes)}
      <p class="muted">Строки с цветным фоном - размеры, которые сейчас есть в наличии. ${chart.note}</p>
      <p class="muted">${HOW_TO}</p>
      <p><a href="/razmery">Все таблицы размеров</a></p></div></details>`;
  }
  if (dept === 'clothes') {
    return html`<details class="acc sizeguide"><summary>Таблица размеров</summary><div class="acc__body">
      <p><b>Женская одежда</b></p>${apparelTable(APPAREL.women)}
      <p><b>Мужская одежда</b></p>${apparelTable(APPAREL.men)}
      <p class="muted">Мерки ориентировочные: у брендов крой разный. Если между размерами, берите больший или спросите менеджера.</p>
      <p><a href="/razmery">Все таблицы размеров</a></p></div></details>`;
  }
  return '';
}

// Страница /razmery: все таблицы
function guidePage() {
  const shoes = CHARTS.filter((c) => c.key !== 'universal').concat(CHARTS.filter((c) => c.key === 'universal'));
  return html`<section class="wrap prose sizepage">
    <nav class="crumbs"><a href="/">Главная</a><span>Таблицы размеров</span></nav>
    <h1>Таблицы размеров</h1>
    <p class="muted">Выберите бренд. Если вашего бренда нет, пользуйтесь универсальной таблицей и ориентируйтесь на длину стопы.</p>
    <nav class="sizepage__nav" aria-label="Бренды">${shoes.map((c) => html`<a href="#${c.key}">${c.title}</a>`)}<a href="#apparel">Одежда</a><a href="#howto">Как измерить стопу</a></nav>
    ${shoes.map((c) => html`<section id="${c.key}"><h2>${c.title}</h2><p class="muted">${c.source}</p>${shoeTable(c)}${c.note ? html`<p class="muted">${c.note}</p>` : html`<p class="muted">У вашего бренда размеры могут отличаться на пол-размера от таблицы: ориентируйтесь на длину стопы.</p>`}</section>`)}
    <section id="apparel"><h2>Одежда</h2><h3>Женская</h3>${apparelTable(APPAREL.women)}<h3>Мужская</h3>${apparelTable(APPAREL.men)}
      <p class="muted">Мерки ориентировочные: у брендов крой разный.</p></section>
    <section id="howto"><h2>Как измерить стопу</h2><p>${HOW_TO}</p></section>
  </section>`;
}

module.exports = { CHARTS, APPAREL, chartFor, parseEu, guideBlock, guidePage, shoeTable };
