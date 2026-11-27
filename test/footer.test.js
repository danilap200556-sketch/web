'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startShop, client, addProduct, addAdmin, adminLogin } = require('./helpers');
const { mapFor, socialUrl, renderText } = require('../src/site');

test.describe('подвал как у больших магазинов, Яндекс Карта, страницы из админки', () => {
  let shop, owner, editor;
  test.before(async () => {
    shop = await startShop('footer');
    await addProduct(shop.db, { sku: 'FT-1_42', name: 'Кроссовки Nike Foot 1', price: 9000, qty: 2, vendor: 'Nike' });
    owner = await adminLogin(shop.base, 'owner1', 'owner-pass-123');
    await addAdmin(shop.db, 'content3', 'editor');
    editor = await adminLogin(shop.base, 'content3', 'pass-12345');
  });
  test.after(async () => { await shop.stop(); });

  test('по умолчанию: карта по адресу магазина, значки оплаты, разрешён только фрейм Яндекса', async () => {
    const r = await client(shop.base).get('/catalog');
    assert.match(r.headers.get('content-security-policy'), /frame-src https:\/\/yandex\.ru;/);
    const t = r.text;
    assert.match(t, /<section class="where"/);
    // Карта Яндекса тянет около 5 МБ и тормозит страницы, поэтому на странице заглушка, а сам фрейм создаёт shop.js по кнопке
    assert.doesNotMatch(t, /<iframe/, 'пока не нажали «Показать карту», фрейма на странице нет');
    assert.match(t, /<div class="where__map" data-map data-map-src="https:\/\/yandex\.ru\/map-widget\/v1\/\?text=[^"]+">/);
    assert.match(t, /<button class="btn btn--light" type="button" data-map-load>Показать карту<\/button>/);
    assert.match(t, /<noscript><a class="btn btn--light" href="https:\/\/yandex\.ru\/maps\/\?text=/, 'без JS - ссылка на Яндекс Карты');
    assert.match(t, /class="pbadge pbadge--mir"/);
    assert.match(t, /class="pbadge pbadge--cdek"/);
    assert.doesNotMatch(t, /Социальные сети/, 'соцсетей нет - нет и колонки');
    assert.doesNotMatch(t, /info\/privacy/, 'политики нет - нет и ссылки');
    assert.match(t, /<h4>Способы связи<\/h4>/);
    assert.match(t, /<h4>Режим работы<\/h4>/);
    assert.match(t, /href="\/contacts">Контакты</);
    const cart = (await client(shop.base).get('/cart')).text;
    assert.doesNotMatch(cart, /class="where"/, 'в корзине карты нет');
  });

  test('политика конфиденциальности всегда есть в нижней строке подвала и в уведомлении о cookie', async () => {
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, /class="foot__copy">[\s\S]*<a href="\/privacy">Политика конфиденциальности<\/a>/, 'без своей страницы ссылка ведёт на /privacy');
    assert.match(home, /<div class="cookie"[\s\S]*<a href="\/privacy">Подробнее<\/a>/);
    const page = await client(shop.base).get('/privacy');
    assert.equal(page.status, 200, 'ссылка не ведёт в пустоту');
    assert.match(page.text, /Политика в отношении обработки персональных данных/);
    for (const h of ['1. Общие положения', '2. Основные понятия', '3. Какие данные мы обрабатываем', '4. Цели и основания обработки', '5. Как мы обрабатываем и защищаем данные',
      '6. Кому мы передаём данные', '7. Права пользователя', '8. Cookie и аналитика', '9. Заключительные положения']) assert.ok(page.text.includes(h), h);
    assert.match(page.text, /Telegram/);
    assert.match(page.text, /ИП Усатов Егор Николаевич, ИНН 616614137900/, 'оператор из реквизитов магазина');
  });

  test('админка: соцсети, значки, карта по координатам, «только на главной»; чужие ссылки не принимаются', async () => {
    const base = { _csrf: owner.csrf, map_title: 'Где мы', map_zoom: '15', map_show: 'home', since: '2021', badges: ['mir', 'sbp', 'ems'] };
    let r = await owner.c.post('/admin/settings/footer', { ...base, soc_vk: 'https://evil.example/vk.com', map_query: '55.7539, 37.6208' });
    assert.equal(r.status, 302);
    let s = await shop.services.settings.get();
    assert.equal(s.socials.vk, '', 'ссылка не с vk.com не сохранилась');
    r = await owner.c.post('/admin/settings/footer', { ...base, soc_vk: 'vk.com/ks', soc_telegram: '@ks_news', soc_youtube: 'javascript:alert(1)', map_query: '55.7539, 37.6208' });
    s = await shop.services.settings.get();
    assert.equal(s.socials.vk, '', 'при ошибке в одной ссылке ничего не сохраняется');
    await owner.c.post('/admin/settings/footer', { ...base, soc_vk: 'vk.com/ks', soc_telegram: '@ks_news', map_query: '55.7539, 37.6208', map_note: 'Вход со двора' });
    s = await shop.services.settings.get();
    assert.equal(s.socials.vk, 'https://vk.com/ks');
    assert.equal(s.socials.telegram, 'https://t.me/ks_news');
    assert.deepEqual(s.badges, ['mir', 'sbp', 'ems']);

    const home = (await client(shop.base).get('/')).text;
    assert.match(home, /src="https:\/\/yandex\.ru\/map-widget\/v1\/\?ll=37\.6208%2C55\.7539&amp;z=15&amp;pt=37\.6208%2C55\.7539%2Cpm2dgl"/);
    assert.match(home, /href="https:\/\/yandex\.ru\/maps\/\?rtext=~55\.7539%2C37\.6208&amp;rtt=auto"/, 'кнопка маршрута');
    assert.match(home, /<h2>Где мы<\/h2>/);
    assert.match(home, /Вход со двора/);
    assert.match(home, /<h4>Социальные сети<\/h4>/);
    assert.match(home, /href="https:\/\/vk\.com\/ks" rel="noopener" target="_blank">/);
    assert.match(home, /pbadge--ems/);
    assert.doesNotMatch(home, /pbadge--cdek/);
    assert.match(home, /© SOLEHOUSE 2021-\d{4}/);
    assert.match(home, /Карта на сайте - сервис Яндекса/, 'в уведомлении о cookie сказано про карту');
    assert.doesNotMatch((await client(shop.base).get('/catalog')).text, /class="where"/, '«только на главной»: в каталоге карты нет');
    const contacts = (await client(shop.base).get('/contacts')).text;
    assert.match(contacts, /<h1>Контакты<\/h1>/);
    assert.match(contacts, /class="where"/, 'в «Контактах» карта есть всегда');
    assert.match(contacts, /Мы в соцсетях/);

    await owner.c.post('/admin/settings/footer', { ...base, map_show: 'off', map_query: '55.7539, 37.6208' });
    assert.doesNotMatch((await client(shop.base).get('/')).text, /class="where"/);
    const bad = await owner.c.post('/admin/settings/footer', { ...base, map_query: 'https://google.com/maps/place/1' });
    assert.equal(bad.status, 302);
    assert.equal((await shop.services.settings.get()).map.show, 'off', 'ссылка не с Яндекс Карт не сохранилась');
    // контент-менеджер подвал не правит
    assert.equal((await editor.c.post('/admin/settings/footer', { _csrf: editor.csrf, map_show: 'all' })).status, 403);
  });

  test('страницы: черновик не виден, опубликованная - в подвале; соглашение и политика - в нижней строке', async () => {
    const list = await editor.c.get('/admin/pages');
    assert.equal(list.status, 200);
    assert.match(list.text, /Быстро создать черновик/);
    let r = await editor.c.post('/admin/pages/preset', { _csrf: editor.csrf, slug: 'privacy' });
    assert.equal(r.status, 302);
    const id = /\/admin\/pages\/(\d+)/.exec(r.headers.get('location'))[1];
    assert.equal((await client(shop.base).get('/info/privacy')).status, 404, 'пустой черновик не виден');
    assert.equal((await editor.c.get('/info/privacy')).status, 200, 'в админке черновик можно посмотреть');

    r = await editor.c.post(`/admin/pages/${id}`, { _csrf: editor.csrf, title: 'Политика конфиденциальности', slug: 'privacy', sort: '90', published: 'on', in_footer: 'on',
      body: '## Какие данные\nИмя и телефон для **заказа**.\n- пункт <script>alert(1)</script>\n\n[ссылка](javascript:alert(1)) и [доставка](/delivery)' });
    assert.equal(r.status, 302);
    const page = await client(shop.base).get('/info/privacy');
    assert.equal(page.status, 200);
    assert.match(page.text, /<h2>Какие данные<\/h2>/);
    assert.match(page.text, /<b>заказа<\/b>/);
    assert.match(page.text, /<li>пункт &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
    assert.doesNotMatch(page.text, /href="javascript/);
    assert.match(page.text, /<a href="\/delivery">доставка<\/a>/);
    const home = (await client(shop.base).get('/')).text;
    assert.match(home, /<li><a href="\/info\/privacy">Политика конфиденциальности<\/a><\/li>/);
    assert.match(home, /class="foot__copy">[\s\S]*href="\/info\/privacy"/);
    assert.match((await client(shop.base).get('/sitemap.xml')).text, /\/info\/privacy</);

    const dup = await editor.c.post('/admin/pages/new', { _csrf: editor.csrf, title: 'Ещё', slug: 'privacy', body: 'x' });
    assert.equal(dup.status, 302);
    assert.equal(dup.headers.get('location'), '/admin/pages/new', 'занятый адрес - назад к форме');
    const reserved = await editor.c.post('/admin/pages/new', { _csrf: editor.csrf, title: 'Контакты', slug: 'contacts', body: 'x' });
    assert.equal(reserved.headers.get('location'), '/admin/pages/new');
    await editor.c.post(`/admin/pages/${id}/delete`, { _csrf: editor.csrf });
    assert.equal((await client(shop.base).get('/info/privacy')).status, 404);
  });

  test('разбор карты, ссылок и текста', () => {
    assert.equal(mapFor({ map: { query: '' } }), null);
    assert.equal(mapFor({ address: 'Москва', map: { show: 'off' } }), null);
    assert.match(mapFor({ map: { query: 'https://yandex.ru/maps/213/moscow/?ll=37.62%2C55.75&z=14' } }).src, /ll=37\.62%2C55\.75&z=14/);
    assert.match(mapFor({ map: { query: '<iframe src="https://yandex.ru/map-widget/v1/?um=constructor%3Aabc123def456ghi&source=constructor">' } }).src, /um=constructor%3Aabc123def456ghi/);
    assert.equal(mapFor({ map: { query: 'https://maps.google.com/?q=1' } }), null);
    assert.equal(socialUrl('whatsapp', 'https://wa.me/79001234567'), 'https://wa.me/79001234567');
    assert.equal(socialUrl('dzen', 'http://dzen.ru/ks'), 'https://dzen.ru/ks');
    assert.equal(socialUrl('vk', 'https://vk.com.evil.ru/x'), '');
    assert.equal(String(renderText('[x](//evil.com)')), '<p>[x](//evil.com)</p>');
  });
});
