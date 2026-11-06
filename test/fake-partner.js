'use strict';
// Поддельный сайт партнёра на OpenCart: разметка карточек и страниц товаров повторяет реальный sergeev-electronics.ru
const http = require('node:http');
const sharp = require('sharp');

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

async function fakePartner(site = {}) {
  const jpeg = await sharp({ create: { width: 520, height: 520, channels: 3, background: '#e8e8ee' } }).jpeg().toBuffer();
  const st = {
    calls: [], times: [], failPaths: new Map(), // путь -> сколько раз ответить ошибкой 500
    robots: 'User-agent: *\nDisallow: /cart\nDisallow: /*?sort=\nDisallow: /private-section\nCrawl-delay: 0\n\nUser-agent: BadBot\nDisallow: /\n',
    sections: {
      'tekhnika-apple': [
        { slug: 'apple-iphone-18-pro-256-black', title: 'Смартфон Apple iPhone 18 Pro 256 Gb (Black)', price: 99990, old: 109990, stock: true },
        { slug: 'apple-airpods-pro-3', title: 'Наушники Apple AirPods Pro 3', price: 24990, old: 0, stock: true },
        { slug: 'apple-mac-mini-m6', title: 'Компьютер Apple Mac mini M6 24/512Gb (Silver)', price: 130290, old: 153290, stock: false },
        { slug: 'apple-watch-s12', title: 'Умные часы Apple Watch Series 12 45mm', price: 45990, old: 0, stock: true },
      ],
      garmin: [
        { slug: 'garmin-forerunner-975', title: 'Часы Garmin Forerunner 975', price: 59990, old: 0, stock: true },
        { slug: 'garmin-fenix-9', title: 'Часы Garmin Fenix 9 Solar', price: 89990, old: 99990, stock: true },
      ],
      ...site.sections,
    },
    perPage: 2, missingSizes: new Set(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = `http://127.0.0.1:${server.address().port}`;
    st.calls.push(req.url); st.times.push(Date.now());
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const left = st.failPaths.get(url.pathname + url.search);
    if (left > 0) { st.failPaths.set(url.pathname + url.search, left - 1); return send(500, 'error'); }
    if (url.pathname === '/robots.txt') return send(200, st.robots, 'text/plain');
    if (url.pathname.startsWith('/image/')) {
      if ([...(st.missingSizes || [])].some((x) => url.pathname.includes(x))) return send(404, 'нет такого размера');
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(jpeg);
    }
    const name = url.pathname.replace(/^\/+/, '');
    if (st.sections[name]) {
      const all = st.sections[name];
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const pages = Math.ceil(all.length / st.perPage);
      const items = all.slice((page - 1) * st.perPage, page * st.perPage);
      const li = items.map((p) => `<li><div class="products__item "><div class="products__item-in">
        <a class="products__item-gallery" href="${base}/product/${p.slug}">
          <div class="products__item-image is-active"><img src="${base}/image/cache/catalog/import/${p.slug}/${p.slug}_1-260x260.jpg" alt="${p.title}" width="260" height="260" loading="lazy"></div>
          <div class="products__item-image"><img data-src="${base}/image/cache/catalog/import/${p.slug}/${p.slug}_2-260x260.jpg" src="${PIXEL}" alt="" width="260" height="260"></div></a>
        <span class="products__item-status products__item-status--${p.stock ? 'true' : 'false'}"></span>
        <a class="products__item-title" href="${base}/product/${p.slug}">${p.title}</a>
        <p class="products__item-price"><span class="se-listing-price-row"><ins>${p.price} ₽ </ins>${p.old ? `<del>${p.old} ₽</del>` : ''}</span><br class="cb-br"><span class="cb-badge">+${Math.round(p.price / 100)}</span></p>
      </div></div></li>`).join('');
      const nav = Array.from({ length: pages }, (_, i) => `<a href="${base}/${name}?page=${i + 1}">${i + 1}</a>`).join('');
      return send(200, `<html><head><title>${name}</title></head><body><ul class="products">${li}</ul><div class="pagination">${nav}</div></body></html>`);
    }
    const prod = url.pathname.match(/^\/product\/([^/]+)$/);
    if (prod) {
      const p = Object.values(st.sections).flat().find((x) => x.slug === prod[1]);
      if (!p) return send(404, 'нет такого');
      const ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.title, sku: `SE-${p.slug}`, brand: p.brand || 'Apple',
        description: `<p>${p.title}.</p><p>Подробное описание: быстрый процессор, яркий экран.</p>`,
        image: [`${base}/image/cache/catalog/import/${p.slug}/${p.slug}_1-1000x1000.jpg`, `${base}/image/cache/catalog/import/${p.slug}/${p.slug}_1-500x500.jpg`, `${base}/image/cache/catalog/import/${p.slug}/${p.slug}_1-100x100.jpg`, `${base}/image/cache/catalog/import/${p.slug}/${p.slug}_2-1000x1000.jpg`, `${base}/image/cache/catalog/import/${p.slug}/${p.slug}_2-500x500.jpg`],
        offers: { '@type': 'Offer', price: String(st.productPrice?.[p.slug] ?? p.price), priceCurrency: 'RUB', availability: (st.productStock?.[p.slug] ?? p.stock) ? 'http://schema.org/InStock' : 'http://schema.org/OutOfStock', url: '' } };
      return send(200, `<html><head><title>${p.title}</title><script type="application/ld+json">{ "@context": "https://schema.org", "@type": "LocalBusiness", "name": "Партнёр" }</script><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>${p.title}</h1></body></html>`);
    }
    send(404, 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { fakePartner };
