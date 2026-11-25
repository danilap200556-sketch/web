'use strict';
// Свои товары: добавляются вручную в админке («Свои товары»), с размерами, остатками, фото и ценой, и продаются как обычные.
//
// Остаток. Склад приложения «Склад» этих товаров не знает, поэтому остаток ведёт сайт. Для размера хранится «поступило» (received),
// а остаток = поступило - проданное в заказах, которые не отменены и не возвращены (в любом другом статусе пара уже не на полке).
// Так отмена и возврат сами возвращают остаток, а дважды ничего не списывается: проданное всегда считается заново по заказам.
// В форме админки владелец вводит «осталось сейчас», а сайт сам пересчитывает поступило = осталось + проданное.
//
// Номера. Размер своего товара - номер OWN_BASE + id строки own_sizes (так он попадает в корзину и заказ), фото - OWN_BASE + id строки own_photos.
const sharp = require('sharp');
const { slugify } = require('./util');
const { parseName, sizeOrder, sitePrice } = require('./model');
const { OWN_BASE } = require('./ext');

const DEPTS = ['shoes', 'clothes', 'accessories', 'electronics'];
const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const SOLD_STATUSES_OFF = ['cancelled', 'returned']; // в этих статусах заказ товар не держит

const ownKey = (id) => `own:${id}`;

// Проданное по номерам размеров: Map(номер размера -> штук). pids - необязательный список номеров (иначе все).
async function soldMap(db, pids = null) {
  const { rows } = await db.query(
    `SELECT oi.product_id, SUM(oi.qty)::int AS q
       FROM webshop.order_items oi JOIN webshop.orders o ON o.id = oi.order_id
      WHERE oi.product_id >= $1 AND o.status <> ALL($2::text[]) ${pids ? 'AND oi.product_id = ANY($3)' : ''}
      GROUP BY oi.product_id`, pids ? [OWN_BASE, SOLD_STATUSES_OFF, pids] : [OWN_BASE, SOLD_STATUSES_OFF]);
  return new Map(rows.map((r) => [Number(r.product_id), r.q]));
}

// Сколько штук свободно у размеров: Map(номер размера -> штук). client - соединение (внутри транзакции заказа) или база.
async function freeMap(client, pids) {
  const ids = pids.map((p) => Number(p) - OWN_BASE).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return new Map();
  const [recv, sold] = await Promise.all([
    client.query('SELECT id, received FROM webshop.own_sizes WHERE id = ANY($1)', [ids]),
    soldMap(client, ids.map((i) => OWN_BASE + i)),
  ]);
  return new Map(recv.rows.map((r) => [OWN_BASE + r.id, Math.max(0, r.received - (sold.get(OWN_BASE + r.id) || 0))]));
}

// Товары, размеры и фото для сайта и админки. id - один товар. Возвращает строки для buildOwnModels.
async function loadOwn(db, { id = null } = {}) {
  const where = id ? 'WHERE p.id = $1' : '';
  const args = id ? [id] : [];
  const [prod, sz, ph, sold] = await Promise.all([
    db.query(`SELECT p.id, p.article, p.name, p.vendor, p.type, p.dept, p.description, p.price::float8 AS price, p.sale_price::float8 AS sale_price,
                     to_char(p.sale_from, 'YYYY-MM-DD') AS sale_from, to_char(p.sale_to, 'YYYY-MM-DD') AS sale_to, p.active, p.created_at
                FROM webshop.own_products p ${where} ORDER BY p.id`, args),
    db.query(`SELECT s.id, s.product_id, s.size, s.received, s.sort FROM webshop.own_sizes s ${id ? 'WHERE s.product_id = $1' : ''} ORDER BY s.sort, s.id`, args),
    db.query(`SELECT f.id, f.product_id FROM webshop.own_photos f ${id ? 'WHERE f.product_id = $1' : ''} ORDER BY f.position, f.id`, args),
    soldMap(db),
  ]);
  const sizesOf = new Map();
  for (const s of sz.rows) {
    if (!sizesOf.has(s.product_id)) sizesOf.set(s.product_id, []);
    sizesOf.get(s.product_id).push({ id: s.id, size: s.size, received: s.received, sold: sold.get(OWN_BASE + s.id) || 0, sort: s.sort });
  }
  const photosOf = new Map();
  for (const f of ph.rows) {
    if (!photosOf.has(f.product_id)) photosOf.set(f.product_id, []);
    photosOf.get(f.product_id).push(f.id);
  }
  return prod.rows.map((p) => ({ ...p, sizes: sizesOf.get(p.id) || [], photos: photosOf.get(p.id) || [] }));
}

// Строки loadOwn -> модели витрины (та же форма, что у моделей склада и партнёров).
function buildOwnModels(rows, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  for (const r of rows) {
    const p = parseName(r.name, r.vendor);
    const sp = sitePrice({ price: Number(r.price), salePrice: Number(r.sale_price) || 0, from: r.sale_from || '', to: r.sale_to || '' }, today);
    const price = sp ? sp.price : Number(r.price);
    const sizes = (r.sizes || [])
      .map((s) => ({
        id: OWN_BASE + s.id, sku: `${r.article || `OWN${r.id}`}${s.size ? `_${s.size}` : ''}`, size: s.size, note: '', label: s.size || 'Один размер',
        qty: Math.max(0, s.received - s.sold), price, order: sizeOrder(s.size), sort: s.sort || 0,
      }))
      .sort((a, b) => a.order - b.order || a.sort - b.sort || a.label.localeCompare(b.label, 'ru'));
    const photos = (r.photos || []).map((id) => OWN_BASE + id);
    const inStock = sizes.some((s) => s.qty > 0);
    const title = [p.brand, p.model].filter(Boolean).join(' ') || r.name;
    out.push({
      key: ownKey(r.id),
      slug: `o${r.id}-${slugify(r.name)}`.slice(0, 90),
      type: p.type || r.type || '',
      brand: p.brand,
      model: p.model,
      colorway: p.colorway,
      title,
      fullName: r.name,
      description: String(r.description || '').trim(),
      dept: r.dept,
      sizes,
      noteOnly: false,
      photos,
      cover: photos[0] || 0,
      price,
      priceMax: price,
      oldPrice: sp ? sp.oldPrice : 0,
      discount: sp ? sp.discount : 0,
      saleTo: sp ? sp.saleTo : '',
      priceSource: 'own',
      qty: sizes.reduce((a, s) => a + s.qty, 0),
      inStock,
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
      search: '',
      own: { id: r.id, article: r.article || '', vendor: r.vendor || '', sold: (r.sizes || []).reduce((a, s) => a + s.sold, 0) },
      hiddenOwn: !r.active,
    });
  }
  return out;
}

// Фото из админки: JPEG, не длиннее 1600 px по большей стороне, фон под прозрачностью белый. null - файл не картинка.
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return true;
  return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}
async function preparePhoto(buf) {
  if (!sniff(buf)) return null;
  try {
    return await sharp(buf, { limitInputPixels: 60_000_000, failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  } catch { return null; }
}

module.exports = { DEPTS, MAX_PHOTOS, MAX_PHOTO_BYTES, ownKey, soldMap, freeMap, loadOwn, buildOwnModels, preparePhoto };
