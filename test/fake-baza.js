'use strict';
// Поддельный сайт bazaplay.ru для тестов: robots.txt, sitemap, страницы товаров с конфигом Bitrix (JCCatalogElement) и картинки.
const http = require('node:http');
const sharp = require('sharp');
const { logoJpeg, cleanJpeg } = require('./logo-fixtures');

const config = ({ id, name, price, base = price, canBuy = true, category = 'Техника Apple', images = [] }) => `<script>
var obCatalogElement = new JCCatalogElement({'CONFIG':{'USE_CATALOG':true},'VISUAL':{'ID':'bx_1_${id}'},'PRODUCT':{'ID':'${id}','ACTIVE':'Y','PICT':{'ID':'1','SRC':'${images[0] || ''}','WIDTH':'651','HEIGHT':'726'},'NAME':'${name}','SUBSCRIPTION':true,'ITEM_PRICE_MODE':'S','ITEM_PRICES':[{'UNROUND_BASE_PRICE':'${base}','UNROUND_PRICE':'${price}','BASE_PRICE':'${base}','PRICE':'${price}','ID':'1','PRICE_TYPE_ID':'1','CURRENCY':'RUB','DISCOUNT':'${base - price}','PERCENT':'0'}],'SLIDER':[${images.map((s, i) => `{'ID':'${i}','SRC':'${s}','WIDTH':'651','HEIGHT':'726'}`).join(',')}],'CAN_BUY':${canBuy},'CHECK_QUANTITY':true,'MAX_QUANTITY':'0','CATEGORY':'${category}'},'BASKET':{'ADD_PROPS':true}});
</script>`;

const page = ({ h1, crumbs, ...cfg }) => `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>${h1} купить</title>
<meta property="product:price:amount" content="${cfg.price}.00"></head><body>
<div class="breadcrumbs"><ul><li><a href="/">Главная</a></li><li><a href="/catalog/">Каталог</a></li>${crumbs.map((c) => `<li><a href="#">${c}</a></li>`).join('')}<li><span>${h1}</span></li></ul></div>
<h1 class="page-product__title">${h1} &middot; Burgundy</h1>${config({ name: h1, ...cfg })}</body></html>`;

// pcs: true - добавляет компьютеры (раздел «Компьютеры») со снимками: с вывеской BAZA и чистыми; st.imageFail - адреса снимков, на которые сайт отвечает 500
async function fakeBaza({ robots, pcs = false } = {}) {
  const img = await sharp({ create: { width: 90, height: 60, channels: 3, background: '#e8e8e8' } }).composite([{ input: { create: { width: 40, height: 20, channels: 3, background: '#222' } }, left: 25, top: 20 }]).jpeg().toBuffer();
  const logoBuf = pcs ? await logoJpeg() : null;
  const cleanBuf = pcs ? await cleanJpeg() : null;
  const st = { hits: [], price: 117990, canBuy: true, imageFail: new Set() };
  let url = '';
  const sitemapUrls = () => [`${url}/catalog/apple/`, `${url}/catalog/apple/iphone/`, `${url}/catalog/apple/iphone-18-pro-256-gb-burgundy-esim/`, `${url}/catalog/apple/old-phone-64-gb/`,
    `${url}/catalog/apple/gone-product/`, `${url}/catalog/secret/hidden-product/`, `${url}/catalog/compare/`, `${url}/catalog/samsung/galaxy-s26-ultra-512-gb/`,
    ...(pcs ? [`${url}/catalog/kompyutery/igrovye_kompyutery/start/start-1-0-black/`, `${url}/catalog/kompyutery/igrovye_kompyutery/silver/silver-2-0-black/`, `${url}/catalog/kompyutery/perifiriya/myshi/mouse-1/`] : [])];
  const server = http.createServer((req, res) => {
    st.hits.push(req.url);
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const u = req.url.split('?')[0];
    if (u === '/robots.txt') return send(200, 'text/plain', robots ?? 'User-agent: *\nDisallow: /upload/\nDisallow: /*PAGEN_\nDisallow: /catalog/secret/\nDisallow: /catalog/compare/\n');
    if (u === '/sitemap.xml') return send(200, 'application/xml', `<?xml version="1.0"?><sitemapindex><sitemap><loc>${url}/sitemap-files.xml</loc></sitemap><sitemap><loc>${url}/sitemap-iblock-1.xml</loc></sitemap></sitemapindex>`);
    if (u === '/sitemap-files.xml') return send(200, 'application/xml', `<urlset><url><loc>${url}/upload/file.pdf</loc></url></urlset>`);
    if (u === '/sitemap-iblock-1.xml') return send(200, 'application/xml', `<urlset>${sitemapUrls().map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`);
    if (u === '/catalog/apple/iphone-18-pro-256-gb-burgundy-esim/') {
      return send(200, 'text/html', page({ h1: 'iPhone 18 Pro 256 ГБ Burgundy eSIM', crumbs: ['Техника Apple', 'iPhone', 'iPhone 18 Pro'], id: 70196, price: st.price, base: st.price + 5000, canBuy: st.canBuy,
        images: ['/upload/iblock/a88/one.webp', '/upload/iblock/6eb/two.webp', '/upload/iblock/6eb/two.webp'] }));
    }
    if (u === '/catalog/apple/old-phone-64-gb/') return send(200, 'text/html', page({ h1: 'Телефон Apple iPhone 14 64Gb', crumbs: ['Техника Apple', 'iPhone'], id: 111, price: 0, canBuy: false, images: ['/upload/iblock/c1/old.webp'] }));
    if (u === '/catalog/samsung/galaxy-s26-ultra-512-gb/') return send(200, 'text/html', page({ h1: 'Смартфон Samsung Galaxy S26 Ultra 512GB', crumbs: ['Samsung', 'Смартфоны'], id: 222, price: 129990, category: 'Samsung', images: ['/upload/iblock/s1/s26.webp'] }));
    if (u === '/catalog/apple/' || u === '/catalog/apple/iphone/') return send(200, 'text/html', '<html><body><h1>Раздел</h1></body></html>');
    if (pcs && u === '/catalog/kompyutery/igrovye_kompyutery/start/start-1-0-black/') return send(200, 'text/html', page({ h1: 'START 1.0 BLACK', crumbs: ['Компьютеры', 'Игровые компьютеры', 'Start'], id: 9101, price: 99990, images: ['/upload/iblock/pc/logo-a.jpg', '/upload/iblock/pc/clean-a.jpg', '/upload/iblock/pc/clean-b.jpg'], category: 'BAZA' }));
    if (pcs && u === '/catalog/kompyutery/igrovye_kompyutery/silver/silver-2-0-black/') return send(200, 'text/html', page({ h1: 'SILVER 2.0 BLACK', crumbs: ['Компьютеры', 'Игровые компьютеры', 'Silver'], id: 9102, price: 149990, images: ['/upload/iblock/pc/logo-b.jpg'], category: 'BAZA' }));
    if (pcs && u === '/catalog/kompyutery/perifiriya/myshi/mouse-1/') return send(200, 'text/html', page({ h1: 'Мышь Ajazz AJ159', crumbs: ['Компьютеры', 'Периферия', 'Мышки'], id: 9103, price: 5990, images: ['/upload/iblock/pc/clean-c.jpg'], category: 'Ajazz' }));
    if (pcs && u.startsWith('/upload/iblock/pc/')) {
      if (st.imageFail.has(u)) return send(500, 'text/plain', 'сбой');
      return send(200, 'image/jpeg', u.includes('/logo-') ? logoBuf : cleanBuf);
    }
    if (u.startsWith('/upload/iblock/')) return send(200, 'image/jpeg', img);
    return send(404, 'text/plain', 'нет такой страницы');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, st, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { fakeBaza };
