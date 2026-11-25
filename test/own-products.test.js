'use strict';
// Свои товары: добавляются вручную в админке («Свои товары»), с размерами, остатками, фото и ценой, и продаются как обычные.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { startShop, client, adminLogin, addAdmin, addProduct, placeOrder, jpeg } = require('./helpers');
const { OWN_BASE, isOwnPid, isExtPid, EXT_BASE } = require('../src/ext');
const { buildOwnModels, ownKey } = require('../src/own');
const cartLib = require('../src/cart');
const { createOrder } = require('../src/orders');

test('номера: товары склада < партнёра < своих; свой товар не считается партнёрским', () => {
  assert.ok(EXT_BASE < OWN_BASE);
  assert.equal(isOwnPid(OWN_BASE + 5), true);
  assert.equal(isExtPid(OWN_BASE + 5), false, 'скидки лояльности и подписи «партнёр» не должны цеплять свои товары');
  assert.equal(isExtPid(EXT_BASE + 5), true);
  assert.equal(isOwnPid(EXT_BASE + 5), false);
  assert.equal(isOwnPid(12), false);
  assert.ok(OWN_BASE + 10_000_000 < 2_147_483_647, 'помещается в целое число базы');
});

test('модель из своего товара: размеры по порядку, остаток = поступило - продано, скидка по датам', () => {
  const today = '2026-05-10';
  const row = (x) => ({ id: 7, article: 'KS-7', name: 'Кроссовки Nike Air Max 90 «Triple Black»', vendor: '', type: '', dept: 'shoes', description: 'Описание', price: 10000, sale_price: 8000, sale_from: '2026-05-01', sale_to: '2026-05-31',
    active: true, created_at: '2026-05-01T10:00:00Z', photos: [3, 4],
    sizes: [{ id: 21, size: '43', received: 2, sold: 2, sort: 1 }, { id: 20, size: '41', received: 3, sold: 1, sort: 0 }, { id: 22, size: '42.5', received: 1, sold: 0, sort: 2 }], ...x });
  const [m] = buildOwnModels([row({})], { today });
  assert.equal(m.key, ownKey(7));
  assert.equal(m.brand, 'Nike');
  assert.equal(m.colorway, 'Triple Black');
  assert.equal(m.dept, 'shoes');
  assert.deepEqual(m.sizes.map((s) => [s.label, s.qty, s.id]), [['41', 2, OWN_BASE + 20], ['42.5', 1, OWN_BASE + 22], ['43', 0, OWN_BASE + 21]]);
  assert.equal(m.inStock, true);
  assert.equal(m.qty, 3);
  assert.equal(m.price, 8000);
  assert.equal(m.oldPrice, 10000);
  assert.equal(m.discount, 20);
  assert.equal(m.saleTo, '2026-05-31');
  assert.deepEqual(m.photos, [OWN_BASE + 3, OWN_BASE + 4]);
  assert.equal(m.cover, OWN_BASE + 3);
  assert.equal(m.own.id, 7);
  const [late] = buildOwnModels([row({})], { today: '2026-06-02' });
  assert.equal(late.price, 10000, 'скидка закончилась');
  assert.equal(late.oldPrice, 0);
  const [bad] = buildOwnModels([row({ sale_price: 12000 })], { today });
  assert.equal(bad.price, 10000, 'цена со скидкой не меньше обычной - скидки нет');
  const [one] = buildOwnModels([row({ sizes: [{ id: 30, size: '', received: 4, sold: 0, sort: 0 }], dept: 'accessories', name: 'Сумка Coach Tabby' })], { today });
  assert.equal(one.sizes[0].label, 'Один размер');
  assert.equal(one.dept, 'accessories');
  assert.equal(buildOwnModels([row({ active: false })], { today }).length, 1, 'скрытый товар остаётся моделью (админка видит его), но скрыт флагом');
  assert.equal(buildOwnModels([row({})], { today })[0].hiddenOwn, false);
  assert.equal(buildOwnModels([row({ active: false })], { today })[0].hiddenOwn, true);
});

test.describe('свои товары в админке и на витрине', () => {
  let shop, owner, editor, manager, wh;
  const cookieOf = (a) => [...a.c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const rows = async (sql, p = []) => (await shop.db.query(sql, p)).rows;
  const product = async (id) => (await rows('SELECT * FROM webshop.own_products WHERE id = $1', [id]))[0];
  const sizes = async (id) => rows('SELECT * FROM webshop.own_sizes WHERE product_id = $1 ORDER BY sort, id', [id]);
  const model = async (id) => { shop.services.catalog.invalidate(); await shop.services.catalog.ensure(); return shop.services.catalog.allModels.find((m) => m.own && m.own.id === id); };
  const form = (o = {}) => ({ _csrf: owner.csrf, name: 'Кроссовки Nike Air Max 90 «Triple Black»', vendor: '', type: '', dept: 'shoes', article: 'KS-AM90', description: 'Классика\n\nВторой абзац', price: '12 990', sale_price: '', sale_from: '', sale_to: '',
    nsize_0: '41', nqty_0: '2', nsize_1: '42', nqty_1: '3', nsize_2: '43', nqty_2: '0', ...o });
  const idFromLocation = (r) => Number(/\/admin\/own\/(\d+)/.exec(r.location)[1]);
  const upload = async (a, id, buf, { csrf = a.csrf, type = 'image/jpeg' } = {}) => {
    const res = await fetch(`${shop.base}/admin/own/${id}/photos`, { method: 'POST', headers: { cookie: cookieOf(a), 'content-type': type, 'x-csrf-token': csrf, accept: 'application/json' }, body: buf });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // Как владелец: сохраняет товар и сразу грузит фото (без фото товар на сайте скрыт правилом «только модели с фото»); nophoto - без фото
  const create = async (o = {}) => {
    const { nophoto, ...rest } = o;
    const r = await owner.c.post('/admin/own', form(rest));
    if (r.status === 302 && !nophoto) assert.equal((await upload(owner, idFromLocation(r), await jpeg())).status, 200);
    return r;
  };

  test.before(async () => {
    shop = await startShop('own');
    owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    await addAdmin(shop.db, 'ed1', 'editor'); await addAdmin(shop.db, 'mg1', 'manager');
    editor = await adminLogin(shop.base, 'ed1', 'pass-12345'); manager = await adminLogin(shop.base, 'mg1', 'pass-12345');
    wh = await addProduct(shop.db, { sku: 'WH-1_42', name: 'Кроссовки Puma Speedcat', price: 9990, qty: 3 });
  });
  test.after(async () => { await shop.stop(); });

  test('доступ: владелец и редактор; менеджеру нельзя; без csrf нельзя', async () => {
    assert.equal((await owner.c.get('/admin/own')).status, 200);
    assert.equal((await editor.c.get('/admin/own')).status, 200);
    assert.equal((await manager.c.get('/admin/own')).status, 403);
    assert.equal((await manager.c.post('/admin/own', form({ _csrf: manager.csrf }))).status, 403);
    const r = await owner.c.post('/admin/own', form({ _csrf: 'wrong' }));
    assert.ok(r.status === 403 || r.status === 400, `без верного токена отказ, а было ${r.status}`);
    assert.equal((await rows('SELECT COUNT(*)::int AS n FROM webshop.own_products'))[0].n, 0);
    assert.match((await owner.c.get('/admin')).text, /Свои товары/, 'пункт меню');
  });

  test('создание: товар, размеры и остатки сохраняются, открывается его страница, на витрине есть размеры', async () => {
    const r = await create();
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const id = idFromLocation(r);
    const p = await product(id);
    assert.equal(p.name, 'Кроссовки Nike Air Max 90 «Triple Black»');
    assert.equal(Number(p.price), 12990, 'пробел в тысячах понимается');
    assert.equal(p.dept, 'shoes');
    assert.equal(p.article, 'KS-AM90');
    assert.equal(p.description, 'Классика\n\nВторой абзац');
    assert.equal(p.active, true);
    const sz = await sizes(id);
    assert.deepEqual(sz.map((s) => [s.size, s.received]), [['41', 2], ['42', 3], ['43', 0]]);
    const m = await model(id);
    assert.equal(m.dept, 'shoes');
    assert.equal(m.price, 12990);
    assert.equal(m.brand, 'Nike');
    assert.deepEqual(m.sizes.map((s) => [s.label, s.qty]), [['41', 2], ['42', 3], ['43', 0]]);
    const page = await client(shop.base).get(`/p/${m.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Air Max 90/);
    assert.match(page.text, /12\s990\s₽/);
    const radios = (page.text.match(/<input type="radio" name="pid"[^>]*>/g) || []).join('\n');
    assert.match(radios, new RegExp(`value="${OWN_BASE + sz[0].id}"\\s+data-size-label="41"`), 'размер 41 можно выбрать: ' + radios);
    assert.match(radios, new RegExp(`value="${OWN_BASE + sz[2].id}"\\s+disabled[^>]*data-size-label="43"`), 'размера 43 нет в наличии: ' + radios);
    assert.match(page.text, /Артикул: KS-AM90/);
    assert.match((await client(shop.base).get('/catalog')).text, /Air Max 90/);
    assert.match((await client(shop.base).get('/catalog?dept=obuv')).text, /Air Max 90/);
  });

  test('ошибки в форме: ничего не сохраняется, введённое остаётся на странице', async () => {
    const count = async () => (await rows('SELECT COUNT(*)::int AS n FROM webshop.own_products'))[0].n;
    const before = await count();
    for (const [o, re] of [[{ name: '' }, /Название/], [{ name: 'Н' }, /Название/], [{ price: '' }, /Цена/], [{ price: 'abc' }, /Цена/], [{ price: '0' }, /Цена/],
      [{ nqty_0: '-1' }, /Остаток/], [{ nqty_0: '1.5' }, /Остаток/], [{ nsize_1: '41' }, /дважды|повтор/i], [{ dept: 'cars' }, /Отдел/],
      [{ sale_price: '20000' }, /скидк/i], [{ sale_price: '9000', sale_from: '2026-13-40' }, /Дат/], [{ nsize_0: '', nqty_0: '', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '' }, /размер/i]]) {
      const r = await create(o);
      assert.equal(r.status, 422, JSON.stringify(o));
      assert.match(r.text, re, JSON.stringify(o));
    }
    const r = await create({ name: 'Кепка без названия бренда', dept: 'cars' });
    assert.match(r.text, /Кепка без названия бренда/, 'введённое остаётся в форме');
    assert.equal(await count(), before);
  });

  test('быстрый набор размеров списком и товар без размера', async () => {
    const r = await create({ name: 'Кроссовки Puma Palermo', article: '', nsize_0: '40', nqty_0: '5', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '', quick_sizes: '38 39, 40;41', quick_qty: '2' });
    assert.equal(r.status, 302, r.text.slice(0, 200));
    const sz = await sizes(idFromLocation(r));
    assert.deepEqual(sz.map((s) => [s.size, s.received]), [['40', 5], ['38', 2], ['39', 2], ['41', 2]], 'явная строка главнее набора; порядок: введённые, затем набор');
    const one = await create({ name: 'Сумка Coach Tabby', dept: 'accessories', article: '', nsize_0: '', nqty_0: '4', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '' });
    assert.equal(one.status, 302);
    const m = await model(idFromLocation(one));
    assert.equal(m.sizes.length, 1);
    assert.equal(m.sizes[0].label, 'Один размер');
    assert.equal(m.dept, 'accessories');
    const e = await create({ name: 'Наушники Sony WH-1000XM6', dept: 'electronics', article: 'SONY-6', nsize_0: '', nqty_0: '3', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '' });
    assert.match((await client(shop.base).get('/catalog?dept=elektronika')).text, /WH-1000XM6/, 'свой товар в отделе «Электроника»');
    assert.equal(e.status, 302);
  });

  test('фото: загрузка, единый вид, главная, удаление; чужим нельзя; плохой файл не принимается', async () => {
    const id = idFromLocation(await create({ name: 'Кроссовки Asics Gel-Kayano 14', article: 'ASX-14', nophoto: true }));
    assert.equal((await model(id)).hidden, true, 'без фото товар скрыт правилом «только модели с фото»');
    assert.match((await owner.c.get(`/admin/own/${id}`)).text, /на сайте его не видно/);
    const big = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#e9e9e9' } }).composite([{ input: { create: { width: 420, height: 160, channels: 3, background: '#222' } }, left: 240, top: 220 }]).jpeg().toBuffer();
    const a = await upload(owner, id, big);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.ok, true);
    const ph = await rows('SELECT id, position, length(data) AS n FROM webshop.own_photos WHERE product_id = $1 ORDER BY position, id', [id]);
    assert.equal(ph.length, 1);
    const first = OWN_BASE + ph[0].id;
    const img = await fetch(`${shop.base}/media/p/${first}/360.jpg`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/jpeg/);
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    assert.equal(`${meta.width}x${meta.height}`, '360x360', 'единый вид: белый квадрат');
    assert.equal((await upload(owner, id, big)).status, 200);
    const m = await model(id);
    assert.equal(m.photos.length, 2);
    assert.equal(m.cover, first);
    assert.equal((await upload(owner, id, Buffer.from('это не картинка, а просто текст'))).status, 400);
    assert.equal((await upload(owner, id, big, { csrf: 'bad' })).status, 403);
    assert.equal((await upload(manager, id, big, { csrf: manager.csrf })).status, 403);
    assert.equal((await upload(editor, id, big, { csrf: editor.csrf })).status, 200, 'редактор тоже может');
    assert.equal((await upload(owner, 999999, big)).status, 404);
    // главная и удаление
    const all = await rows('SELECT id FROM webshop.own_photos WHERE product_id = $1 ORDER BY position, id', [id]);
    const second = all[1].id;
    let r = await owner.c.post(`/admin/own/${id}/photos/${second}/cover`, { _csrf: owner.csrf });
    assert.equal(r.status, 302);
    assert.equal((await model(id)).cover, OWN_BASE + second, 'выбранное фото стало главным');
    r = await owner.c.post(`/admin/own/${id}/photos/${second}/delete`, { _csrf: owner.csrf });
    assert.equal(r.status, 302);
    assert.equal((await model(id)).photos.length, 2);
    assert.equal((await fetch(`${shop.base}/media/p/${OWN_BASE + second}/360.jpg`)).status, 404, 'удалённое фото не отдаётся');
    // не больше 12 фото на товар
    for (let i = 0; i < 12; i++) await upload(owner, id, big);
    const over = await upload(owner, id, big);
    assert.equal(over.status, 400);
    assert.match(over.json.error, /12/);
    assert.equal((await rows('SELECT COUNT(*)::int AS n FROM webshop.own_photos WHERE product_id = $1', [id]))[0].n, 12);
  });

  test('заказ: остаток уменьшается, отмена возвращает, отправленный остаётся списанным; последний экземпляр достаётся одному', async () => {
    const id = idFromLocation(await create({ name: 'Кроссовки Reebok Club C 85', article: 'RBK-85', nsize_0: '41', nqty_0: '2', nsize_1: '42', nqty_1: '1', nsize_2: '', nqty_2: '' }));
    const [s41, s42] = await sizes(id);
    const pid41 = OWN_BASE + s41.id;
    const left = async (pid) => (await model(id)).sizes.find((s) => s.id === pid).qty;
    const o1 = await placeOrder(shop, pid41, { qty: 2, phone: '89160000101' });
    assert.equal(await left(pid41), 0, 'оба экземпляра в заказе');
    const item = (await rows('SELECT * FROM webshop.order_items WHERE order_id = $1', [o1.orderId]))[0];
    assert.equal(item.product_id, pid41);
    assert.equal(item.size, '41');
    assert.equal(item.title.includes('Reebok Club C 85'), true);
    // отмена возвращает остаток
    const status = (oid, st) => owner.c.post(`/admin/orders/${oid}/status`, { _csrf: owner.csrf, status: st });
    assert.equal((await status(o1.orderId, 'cancelled')).status, 302);
    assert.equal(await left(pid41), 2, 'отменённый заказ остаток вернул');
    assert.equal((await status(o1.orderId, 'new')).status, 302);
    assert.equal(await left(pid41), 0, 'вернули в работу - снова в резерве');
    for (const st of ['confirmed', 'paid', 'packed', 'shipped', 'delivered']) { await status(o1.orderId, st); assert.equal(await left(pid41), 0, `статус ${st}: пара ушла и остаток не возвращается`); }
    assert.equal((await status(o1.orderId, 'returned')).status, 302);
    assert.equal(await left(pid41), 2, 'возврат - пара снова на складе сайта');
    // гонка за последним экземпляром
    await shop.services.catalog.ensure();
    const priced = cartLib.price(shop.services.catalog, [{ pid: OWN_BASE + s42.id, qty: 1 }]);
    const f = (phone) => ({ name: 'Гонка', phone, email: '', comment: '', city: '', address: '', point: 'Магазин', door: false, pay: 'cod', delivery: { code: 'pickup', title: 'Самовывоз', kind: 'pickup' }, deliveryCost: 0, total: 1 });
    const res = await Promise.allSettled([createOrder(shop.db, { form: f('79000000021'), priced, catalog: shop.services.catalog }), createOrder(shop.db, { form: f('79000000022'), priced, catalog: shop.services.catalog })]);
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1, 'последний экземпляр достался одному покупателю');
    assert.match(res.find((r) => r.status === 'rejected').reason.message, /разобрали/);
    // в корзину больше остатка не положить
    await shop.services.catalog.ensure();
    const capped = cartLib.price(shop.services.catalog, [{ pid: pid41, qty: 4 }]).lines[0];
    assert.equal(capped.max, 2, 'в корзине больше остатка не положить');
  });

  test('очередь списания «Склада» своих товаров не касается; в заказе нет метки «партнёр»', async () => {
    const id = idFromLocation(await create({ name: 'Худи Carhartt WIP Detroit', dept: 'clothes', article: 'CH-DET', nsize_0: 'M', nqty_0: '3', nsize_1: 'L', nqty_1: '2', nsize_2: '', nqty_2: '' }));
    const [m1] = await sizes(id);
    const mixed = await placeOrder(shop, [OWN_BASE + m1.id, wh], { phone: '89160000102' });
    const own = await placeOrder(shop, OWN_BASE + m1.id, { phone: '89160000103' });
    for (const o of [mixed, own]) await owner.c.post(`/admin/orders/${o.orderId}/status`, { _csrf: owner.csrf, status: 'packed' });
    await shop.services.writeoff.sync();
    const q = await rows("SELECT order_ref, lines FROM order_writeoffs WHERE source = 'site' ORDER BY id");
    assert.equal(q.some((x) => x.order_ref === own.number), false, 'заказ только из своих товаров в очередь списания не попадает');
    const line = q.find((x) => x.order_ref === mixed.number);
    assert.ok(line, 'смешанный заказ в очереди');
    assert.deepEqual(line.lines.map((l) => l.key), ['WH-1_42'], 'в очереди только товар склада');
    const page = (await owner.c.get(`/admin/orders/${own.orderId}`)).text;
    assert.match(page, /Carhartt WIP Detroit/);
    assert.doesNotMatch(page, /партнёр/i);
    assert.doesNotMatch(page, /Sergeev/);
  });

  test('правка: «осталось» пересчитывается с учётом проданного, размеры переименовываются, добавляются и убираются, цена и скидка меняются', async () => {
    const id = idFromLocation(await create({ name: 'Кеды Converse Chuck 70', article: 'CV-70', nsize_0: '40', nqty_0: '3', nsize_1: '41', nqty_1: '2', nsize_2: '', nqty_2: '' }));
    const [a, b] = await sizes(id);
    await placeOrder(shop, OWN_BASE + a.id, { phone: '89160000104' });           // продан один
    const edit = (o) => owner.c.post(`/admin/own/${id}`, { ...form({ name: 'Кеды Converse Chuck 70', article: 'CV-70', price: '9 990', sale_price: '7 990', sale_from: '2020-01-01', sale_to: '2099-12-31' }), nsize_0: '', nqty_0: '', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '',
      sids: `${a.id},${b.id}`, [`size_${a.id}`]: '40', [`qty_${a.id}`]: '2', [`size_${b.id}`]: '41', [`qty_${b.id}`]: '2', ...o });
    let m = await model(id);
    assert.equal(m.sizes.find((s) => s.label === '40').qty, 2, 'было 3, продан 1');
    let r = await edit({ [`qty_${a.id}`]: '5' });
    assert.equal(r.status, 302, r.text.slice(0, 200));
    assert.equal((await sizes(id)).find((s) => s.id === a.id).received, 6, 'поступило = осталось 5 + продано 1');
    m = await model(id);
    assert.equal(m.sizes.find((s) => s.label === '40').qty, 5);
    r = await edit({ [`size_${a.id}`]: '40.5', [`qty_${a.id}`]: '5', nsize_0: '44', nqty_0: '7', [`rm_${b.id}`]: 'on', price: '9 990', sale_price: '7 990', sale_from: '2020-01-01', sale_to: '2099-12-31', description: 'Новое описание' });
    assert.equal(r.status, 302);
    m = await model(id);
    assert.deepEqual(m.sizes.map((s) => [s.label, s.qty]), [['40.5', 5], ['44', 7]]);
    assert.equal(m.price, 7990);
    assert.equal(m.oldPrice, 9990);
    assert.equal(m.discount, 20);
    assert.equal(m.description, 'Новое описание');
    assert.equal((await rows('SELECT COUNT(*)::int AS n FROM webshop.own_sizes WHERE id = $1', [b.id]))[0].n, 0);
    // заказ пришёл, пока форма была открыта: неизменённый остаток не «возвращает» проданную пару
    await placeOrder(shop, OWN_BASE + a.id, { phone: '89160000106' });
    const other = (await sizes(id)).map((x) => x.id).find((x) => x !== a.id);
    const only = { sids: String(a.id), nsize_0: '', nqty_0: '' };
    r = await edit({ ...only, [`size_${a.id}`]: '40.5', [`qty_${a.id}`]: '5', [`was_${a.id}`]: '5' });
    assert.equal(r.status, 302, r.text.slice(0, 200));
    assert.equal((await model(id)).sizes.find((s) => s.label === '40.5').qty, 4, 'остаток остался 4: форма показывала 5, но поле не меняли');
    await edit({ ...only, [`size_${a.id}`]: '40.5', [`qty_${a.id}`]: '9', [`was_${a.id}`]: '5' });
    assert.equal((await model(id)).sizes.find((s) => s.label === '40.5').qty, 9, 'а если остаток изменили - берётся введённое число');
    // размеры меняются местами без ошибки
    r = await edit({ sids: `${a.id},${other}`, nsize_0: '', nqty_0: '', [`size_${a.id}`]: '44', [`qty_${a.id}`]: '9', [`was_${a.id}`]: '9', [`size_${other}`]: '40.5', [`qty_${other}`]: '7', [`was_${other}`]: '7' });
    assert.equal(r.status, 302, r.text.slice(0, 300));
    assert.deepEqual((await model(id)).sizes.map((s) => [s.label, s.qty]), [['40.5', 7], ['44', 9]]);
    // ошибка в правке ничего не меняет
    r = await edit({ price: 'много' });
    assert.equal(r.status, 422);
    assert.equal(Number((await product(id)).price), 9990);
    assert.match((await owner.c.get(`/admin/own/${id}`)).text, /Converse Chuck 70/);
    assert.equal((await owner.c.get('/admin/own/999999')).status, 404);
  });

  test('скрыть и вернуть; удалить можно только товар без заказов', async () => {
    const id = idFromLocation(await create({ name: 'Шапка Nike Beanie', dept: 'accessories', article: 'NK-B', nsize_0: '', nqty_0: '3', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '' }));
    const slug = (await model(id)).slug;
    assert.equal((await client(shop.base).get(`/p/${slug}`)).status, 200);
    let r = await owner.c.post(`/admin/own/${id}/hide`, { _csrf: owner.csrf, hide: '1' });
    assert.equal(r.status, 302);
    assert.equal((await product(id)).active, false);
    assert.equal((await client(shop.base).get(`/p/${slug}`)).status, 404, 'скрытый на витрине не открывается');
    assert.doesNotMatch((await client(shop.base).get('/catalog?dept=aksessuary')).text, /Nike Beanie/);
    assert.match((await owner.c.get('/admin/own')).text, /Nike Beanie/, 'в админке виден');
    r = await owner.c.post(`/admin/own/${id}/hide`, { _csrf: owner.csrf, hide: '0' });
    assert.equal((await client(shop.base).get(`/p/${slug}`)).status, 200);
    // с заказом удалить нельзя
    const sz = (await sizes(id))[0];
    await placeOrder(shop, OWN_BASE + sz.id, { phone: '89160000105' });
    r = await owner.c.post(`/admin/own/${id}/delete`, { _csrf: owner.csrf });
    assert.equal(r.status, 302);
    assert.ok(await product(id), 'товар с заказами остался');
    // без заказов - удаляется вместе с размерами и фото
    const id2 = idFromLocation(await create({ name: 'Ремень Gucci Basic', dept: 'accessories', article: 'GC-1', nsize_0: '', nqty_0: '1', nsize_1: '', nqty_1: '', nsize_2: '', nqty_2: '' }));
    await upload(owner, id2, await jpeg());
    r = await owner.c.post(`/admin/own/${id2}/delete`, { _csrf: owner.csrf });
    assert.equal(r.status, 302);
    assert.equal(await product(id2), undefined);
    assert.equal((await rows('SELECT COUNT(*)::int AS n FROM webshop.own_sizes WHERE product_id = $1', [id2]))[0].n, 0);
    assert.equal((await rows('SELECT COUNT(*)::int AS n FROM webshop.own_photos WHERE product_id = $1', [id2]))[0].n, 0);
  });

  test('список в админке: поиск, остаток, подписи; страницы форм открываются', async () => {
    const list = (await owner.c.get('/admin/own')).text;
    assert.match(list, /Air Max 90/);
    assert.match(list, /Добавить товар/);
    const found = (await owner.c.get('/admin/own?q=reebok')).text;
    assert.match(found, /Reebok Club C 85/);
    assert.doesNotMatch(found, /Air Max 90/);
    const nw = await owner.c.get('/admin/own/new');
    assert.equal(nw.status, 200);
    assert.match(nw.text, /name="nsize_0"/);
    assert.match(nw.text, /name="quick_sizes"/);
  });

  test('свои товары в «Витрине и каталоге»: цену там править нельзя, ссылка ведёт в «Свои товары»', async () => {
    const m = (shop.services.catalog.allModels.find((x) => x.own && /Air Max 90/.test(x.title)));
    const r = await owner.c.post('/admin/showcase/price', { _csrf: owner.csrf, key: m.key, price: '1', back: '/admin/showcase' });
    assert.equal(r.status, 302);
    const after = await model(m.own.id);
    assert.equal(after.price, m.price, 'цена не изменилась через витрину');
    assert.match((await owner.c.get('/admin/showcase')).text, /Свои товары/);
  });
});
