'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addAdmin, adminLogin } = require('./helpers');

let shop;
let pid;
let orderId;
let orderNumber;

test.before(async () => {
  shop = await startShop('admin');
  const { db } = shop;
  pid = await addProduct(db, { sku: 'AD-1_41', name: 'Кроссовки Nike Dunk Low «Panda»', price: 11990, qty: 1 });
  await addAdmin(db, 'manager1', 'manager');
  await addAdmin(db, 'editor1', 'editor');
  await addAdmin(db, 'blocked1', 'manager');
  await db.query("UPDATE webshop.admin_users SET active = FALSE WHERE username = 'blocked1'");

  // один заказ от покупателя
  const c = client(shop.base);
  await c.get('/');
  await c.post('/cart/add', { pid });
  const html = (await c.get('/checkout')).text;
  const r = await c.post('/checkout', {
    idem: /name="idem" value="([^"]+)"/.exec(html)[1], name: 'Анна Петрова', phone: '89161234567', delivery: 'pickup',
    point: /name="point" value="(\d+)"/.exec(html)[1], pay: 'online', consent: '1',
  });
  orderNumber = /\/order\/(\d+)/.exec(r.location)[1];
  orderId = (await db.query('SELECT id FROM webshop.orders WHERE number = $1', [orderNumber])).rows[0].id;
});
test.after(async () => { await shop.stop(); });

test('без входа админка закрыта, вход ведёт обратно на страницу', async () => {
  const c = client(shop.base);
  const r = await c.get('/admin/orders');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/admin\/login\?next=%2Fadmin%2Forders/);
  assert.equal((await c.post('/admin/orders/1/status', { status: 'paid' })).status, 302);
  assert.equal((await c.get('/admin/login')).status, 200);
});

test('вход: неверный пароль, отключённый сотрудник, правильный пароль', async () => {
  const c = client(shop.base);
  const bad = await c.post('/admin/login', { username: 'owner1', password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Неверный логин или пароль/);
  assert.equal((await c.post('/admin/login', { username: 'blocked1', password: 'pass-12345' })).status, 401);
  assert.equal((await c.post('/admin/login', { username: 'nobody', password: 'x' })).status, 401);
  const ok = await c.post('/admin/login', { username: 'OWNER1', password: 'owner-pass-123', next: '/admin/orders' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin/orders');
  assert.equal((await c.get('/admin')).status, 200);
});

test('вход: после серии неверных паролей аккаунт блокируется временно', async () => {
  const c = client(shop.base);
  for (let i = 0; i < 8; i++) await c.post('/admin/login', { username: 'victim', password: 'bad' + i });
  const r = await c.post('/admin/login', { username: 'victim', password: 'bad' });
  assert.equal(r.status, 401);
  assert.match(r.text, /Слишком много попыток/);
});

test('внешний редирект после входа невозможен', async () => {
  const c = client(shop.base);
  const r = await c.post('/admin/login', { username: 'owner1', password: 'owner-pass-123', next: '//evil.example/x' });
  assert.equal(r.location, '/admin');
});

test('роли: менеджер без настроек, контент-менеджер без заказов', async () => {
  const m = await adminLogin(shop.base, 'manager1', 'pass-12345');
  assert.equal((await m.c.get('/admin/orders')).status, 200);
  assert.equal((await m.c.get('/admin/customers')).status, 200);
  assert.equal((await m.c.get('/admin/users')).status, 403);
  assert.equal((await m.c.get('/admin/delivery')).status, 403);
  assert.equal((await m.c.get('/admin/showcase')).status, 403);

  const e = await adminLogin(shop.base, 'editor1', 'pass-12345');
  assert.equal((await e.c.get('/admin/showcase')).status, 200);
  assert.equal((await e.c.get('/admin/orders')).status, 403);
  assert.equal((await e.c.get('/admin/customers')).status, 403);
  const home = await e.c.get('/admin');
  assert.equal(home.status, 302, 'у контент-менеджера нет сводки с деньгами');
  assert.equal(home.location, '/admin/showcase');
  assert.equal((await e.c.post('/admin/orders/1/status', { status: 'paid', _csrf: e.csrf })).status, 403);
});

test('POST без csrf-токена отклоняется', async () => {
  const { c } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  const r = await c.post(`/admin/orders/${orderId}/status`, { status: 'confirmed' });
  assert.equal(r.status, 403);
  assert.match(r.text, /Страница устарела/); // понятный экран с кнопкой «Вернуться», а не голый текст
  assert.match(r.text, /не сохранены/);
  assert.match(r.text, /<a class="btn" href="\/admin/);
  const st = (await shop.db.query('SELECT status FROM webshop.orders WHERE id = $1', [orderId])).rows[0].status;
  assert.equal(st, 'new');
});

test('сводка, заказы, клиенты и посещаемость открываются с данными', async () => {
  const { c } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  const dash = await c.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Выручка/);
  assert.match(dash.text, /11\s?990/);
  assert.match(dash.text, /<svg[^>]+data-tips=/);
  for (const range of ['1', '7', '90']) assert.equal((await c.get('/admin?range=' + range)).status, 200);
  const list = await c.get('/admin/orders');
  assert.match(list.text, new RegExp(orderNumber));
  assert.match(list.text, /Анна Петрова/);
  assert.match((await c.get('/admin/orders?q=9161234567')).text, /Анна Петрова/, 'поиск по телефону');
  assert.doesNotMatch((await c.get('/admin/orders?q=zzzzz')).text, /Анна Петрова/);
  assert.doesNotMatch((await c.get('/admin/orders?status=delivered')).text, /Анна Петрова/);
  assert.match((await c.get('/admin/customers')).text, /Анна Петрова/);
  assert.equal((await c.get('/admin/traffic')).status, 200);
  const detail = await c.get(`/admin/orders/${orderId}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Заказ № /);
  assert.equal((await c.get('/admin/orders/999999')).status, 404);
});

test('смена статуса пишется в историю; отмена возвращает товар в продажу', async () => {
  const { c, csrf } = await adminLogin(shop.base, 'manager1', 'pass-12345');
  // пара в резерве заказа
  assert.match((await client(shop.base).get('/p/ad-1')).text, /Нет в наличии/);
  let r = await c.post(`/admin/orders/${orderId}/status`, { _csrf: csrf, status: 'confirmed', note: 'Позвонили' });
  assert.equal(r.status, 302);
  let ev = (await shop.db.query('SELECT text, admin_name FROM webshop.order_events WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [orderId])).rows[0];
  assert.match(ev.text, /Новый → Подтверждён\. Позвонили/);
  assert.equal(ev.admin_name, 'manager1');
  r = await c.post(`/admin/orders/${orderId}/status`, { _csrf: csrf, status: 'nonsense' });
  assert.equal((await shop.db.query('SELECT status FROM webshop.orders WHERE id = $1', [orderId])).rows[0].status, 'confirmed');

  r = await c.post(`/admin/orders/${orderId}/status`, { _csrf: csrf, status: 'cancelled' });
  assert.match((await client(shop.base).get('/p/ad-1')).text, /В наличии/, 'после отмены пара снова продаётся');
  await c.post(`/admin/orders/${orderId}/status`, { _csrf: csrf, status: 'new' });
  assert.match((await client(shop.base).get('/p/ad-1')).text, /Нет в наличии/, 'вернули в работу - снова в резерве');

  await c.post(`/admin/orders/${orderId}/track`, { _csrf: csrf, track: 'CD123456' });
  assert.equal((await shop.db.query('SELECT track_number FROM webshop.orders WHERE id = $1', [orderId])).rows[0].track_number, 'CD123456');
  await c.post(`/admin/orders/${orderId}/note`, { _csrf: csrf, note: 'Клиент просил перезвонить' });
  assert.match((await c.get(`/admin/orders/${orderId}`)).text, /просил перезвонить/);
});

test('сотрудники: создание, смена роли, защита последнего владельца, длинный пароль', async () => {
  const { c, csrf } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  let r = await c.post('/admin/users', { _csrf: csrf, username: 'new.manager', display_name: 'Новый', role: 'manager', password: 'short' });
  assert.equal(r.status, 302);
  assert.equal((await shop.db.query("SELECT COUNT(*)::int AS n FROM webshop.admin_users WHERE username = 'new.manager'")).rows[0].n, 0, 'пароль короче 8 знаков');
  await c.post('/admin/users', { _csrf: csrf, username: 'new.manager', display_name: 'Новый', role: 'manager', password: 'long-password-1' });
  assert.equal((await shop.db.query("SELECT role FROM webshop.admin_users WHERE username = 'new.manager'")).rows[0].role, 'manager');
  assert.equal((await adminLogin(shop.base, 'new.manager', 'long-password-1')).csrf.length > 10, true);

  // единственного владельца нельзя понизить или отключить
  const owner = (await shop.db.query("SELECT id FROM webshop.admin_users WHERE username = 'owner1'")).rows[0].id;
  await c.post(`/admin/users/${owner}`, { _csrf: csrf, display_name: 'X', role: 'manager', active: 'on' });
  assert.equal((await shop.db.query('SELECT role FROM webshop.admin_users WHERE id = $1', [owner])).rows[0].role, 'owner');
  await c.post(`/admin/users/${owner}`, { _csrf: csrf, display_name: 'X', role: 'owner' });
  assert.equal((await shop.db.query('SELECT active FROM webshop.admin_users WHERE id = $1', [owner])).rows[0].active, true);
});

test('смена пароля закрывает старые входы', async () => {
  const old = await adminLogin(shop.base, 'editor1', 'pass-12345');
  const fresh = await adminLogin(shop.base, 'editor1', 'pass-12345');
  let r = await fresh.c.post('/admin/account', { _csrf: fresh.csrf, current: 'wrong', password: 'brand-new-pass-1' });
  assert.equal(r.status, 302);
  assert.equal((await adminLogin(shop.base, 'editor1', 'pass-12345')).csrf.length > 10, true, 'с неверным текущим пароль не меняется');
  r = await fresh.c.post('/admin/account', { _csrf: fresh.csrf, current: 'pass-12345', password: 'brand-new-pass-1' });
  assert.equal(r.status, 302);
  assert.equal((await old.c.get('/admin/showcase')).status, 302, 'старая сессия недействительна');
  assert.equal((await fresh.c.get('/admin/showcase')).status, 200, 'текущая сессия остаётся');
  assert.equal((await adminLogin(shop.base, 'editor1', 'brand-new-pass-1')).csrf.length > 10, true);
});

test('витрина: сезон, скрытие модели и ярлык действуют на сайте; предпросмотр - только админу', async () => {
  const { c, csrf } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  await c.post('/admin/showcase/season', { _csrf: csrf, mode: 'winter', requirePhoto: 'on', electronicsTeaser: 'on', title_winter: 'Моя зимняя подборка' });
  const guest = client(shop.base);
  const home = (await guest.get('/')).text;
  assert.match(home, /data-season="winter"/);
  assert.match(home, /Моя зимняя подборка/);
  // предпросмотр другого сезона: гость его не получает
  assert.match((await guest.get('/?preview_season=summer')).text, /data-season="winter"/);
  assert.match((await c.get('/?preview_season=summer')).text, /data-season="summer"/);

  await c.post('/admin/showcase/model', { _csrf: csrf, key: 'AD-1', hidden: 'on', badge: '', back: '/admin/showcase' });
  assert.equal((await guest.get('/p/ad-1')).status, 404, 'скрытая модель недоступна');
  await c.post('/admin/showcase/model', { _csrf: csrf, key: 'AD-1', featured: 'on', badge: 'Хит', back: '/admin/showcase' });
  assert.match((await guest.get('/catalog?all=1')).text, /Хит/);
  await c.post('/admin/showcase/season', { _csrf: csrf, mode: 'auto', requirePhoto: 'on' });
});

test('доставка: правка цены применяется на оформлении, выключенный способ пропадает', async () => {
  const { c, csrf } = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
  await c.post('/admin/delivery/method/cdek', { _csrf: csrf, title: 'СДЭК Экспресс', price: '777', door_extra: '100', free_from: '', eta: '1-2 дня', cities: '', description: 'Быстро', sort: '30', active: 'on' });
  const g = client(shop.base);
  const free = await addProduct(shop.db, { sku: 'DL-1_42', name: 'Кроссовки Nike Delivery Test', price: 7000, qty: 2 });
  await g.post('/cart/add', { pid: free });
  const co = (await g.get('/checkout')).text;
  assert.match(co, /СДЭК Экспресс/);
  assert.match(co, /data-price="777"/);
  await c.post('/admin/delivery/method/cdek', { _csrf: csrf, title: 'СДЭК Экспресс', price: '777' });
  assert.doesNotMatch((await g.get('/checkout')).text, /СДЭК Экспресс/, 'без галочки способ выключен');
});
