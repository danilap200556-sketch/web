'use strict';
// Личный кабинет покупателя: вход (SMS, Telegram, почта и пароль), выход, кабинет.
// Состояние входа лежит в req.customer (его выставляет app.js по cookie сессии).
const { normalizePhone, dateFmt } = require('../util');
const { hashPassword, verifyPassword } = require('../security');
const { CodeError } = require('../auth-codes');
const { SmsError } = require('../sms');
const { AccountError } = require('../accounts');
const sec = require('../security');
const views = require('../accountviews');
const { sellerName } = require('../shopviews');

module.exports = function mount(app, services, shopCtx, send) {
  const { cfg, db, pages, accounts, sessions, codes, sms, mail, bot } = services;
  const { cookieOpts } = app.locals.cookies;

  const loginOn = () => sms.enabled() || bot.enabled();
  const tabs = () => [bot.enabled() && 'tg', sms.enabled() && 'sms', 'pw'].filter(Boolean);
  const tgLimiter = new sec.RateLimiter(20, 10 * 60_000);   // ссылки входа на один адрес: не засорять таблицу
  const loginLimiter = new sec.RateLimiter(5, 15 * 60_000); // неудачные пароли: пять за 15 минут на адресат и на пару «адрес + IP»
  const forgotLimiter = new sec.RateLimiter(5, 15 * 60_000);
  const DUMMY_HASH = hashPassword('пароль-для-выравнивания-времени'); // неизвестный логин проверяется так же долго, как известный
  const notFound = (res) => res.status(404).type('text').send('Не найдено');

  // Куда вернуть после входа: только путь на этом же сайте
  const safeNext = (v) => { const s = String(v || ''); return /^\/(?![/\\])[^\s\u0000-\u001f]{0,198}$/.test(s) ? s : ''; };

  // Страницы аккаунта не кэшируются и закрыты от поисковиков
  const page = (req, res, status, title, body) => {
    res.set('Cache-Control', 'no-store');
    send(req, res, { title, noindex: true, bodyClass: 'page-plain', body }, status);
  };

  // tg: { step, token, url } для вкладки Telegram
  function loginPage(req, res, status, { tab = '', step = 'phone', phone = '', next = '', error = '', login = '', tg = { step: 'start' } } = {}) {
    const t = tabs();
    const cur = t.includes(tab) ? tab : t[0];
    page(req, res, status, 'Вход', views.loginView({ tabs: t, tab: cur, next, error, panes: {
      sms: views.smsPane({ step, phone, next }),
      tg: views.tgPane({ ...tg, next }),
      pw: views.pwPane({ next, login }),
    } }));
  }

  // Подтверждённый телефон -> клиент и «свежая» сессия (пароль можно сменить без старого)
  async function startSession(req, res, phone, { telegramId = null } = {}) {
    const { customer, created } = await accounts.ensureByVerifiedPhone(phone, {});
    if (telegramId) await accounts.bindTelegram(customer.id, telegramId);
    const token = await sessions.create(customer.id, { ip: req.ip || '', ua: req.get('user-agent') || '', fresh: true });
    res.cookie(sessions.cookieName, token, cookieOpts(cfg.customer.sessionDays * 86400_000));
    await accounts.touchLogin(customer.id);
    return { customer, created };
  }

  app.get('/login', shopCtx, (req, res) => {
    if (!loginOn()) return notFound(res);
    if (req.customer) return res.redirect('/account');
    loginPage(req, res, 200, { tab: String(req.query.tab || ''), next: safeNext(req.query.next) });
  });

  // ---------- SMS ----------
  app.post('/login/sms/send', shopCtx, async (req, res, next) => {
    try {
      if (!sms.enabled()) return notFound(res);
      const nx = safeNext(req.body.next);
      const phone = normalizePhone(req.body.phone);
      const show = (status, error, step = 'phone') => loginPage(req, res, status, { tab: 'sms', step, phone, next: nx, error });
      if (!phone) return show(422, 'Укажите телефон в формате +7 900 123-45-67');
      if (req.body.consent !== 'on' && req.body.consent !== '1') return show(422, 'Нужно согласие на обработку персональных данных');
      let code;
      try {
        ({ code } = await codes.issue({ purpose: 'login-sms', channel: 'sms', target: phone, ip: req.ip || '' }));
      } catch (e) {
        if (!(e instanceof CodeError)) throw e;
        return show(429, e.reason === 'cap'
          ? 'Сейчас не получается отправить SMS. Попробуйте позже или войдите другим способом.'
          : 'Слишком часто. Подождите минуту, а если код не пришёл, попробуйте позже.');
      }
      try {
        await sms.send(phone, `${code} - код для входа на ${req.ctx.settings.shopName}. Никому не сообщайте его.`);
      } catch (e) {
        if (!(e instanceof SmsError)) throw e;
        console.warn('[sms]', e.message);
        return show(502, 'Не удалось отправить SMS. Попробуйте позже или войдите другим способом.');
      }
      show(200, '', 'code');
    } catch (e) { next(e); }
  });

  app.post('/login/sms/verify', shopCtx, async (req, res, next) => {
    try {
      if (!sms.enabled()) return notFound(res);
      const nx = safeNext(req.body.next);
      const phone = normalizePhone(req.body.phone);
      const ok = phone && await codes.verify({ purpose: 'login-sms', target: phone, code: String(req.body.code || '').replace(/\s+/g, '') });
      if (!ok) return loginPage(req, res, 422, { tab: 'sms', step: 'code', phone, next: nx, error: 'Неверный или просроченный код. Проверьте цифры или запросите новый.' });
      const { created } = await startSession(req, res, phone);
      res.redirect(created && !nx ? '/account/welcome' : (nx || '/account'));   // новому аккаунту предлагаем задать пароль и почту
    } catch (e) { next(e); }
  });

  // ---------- Telegram ----------
  app.post('/login/telegram/start', shopCtx, async (req, res, next) => {
    try {
      if (!bot.enabled()) return notFound(res);
      const nx = safeNext(req.body.next);
      if (req.body.consent !== 'on' && req.body.consent !== '1') return loginPage(req, res, 422, { tab: 'tg', next: nx, error: 'Нужно согласие на обработку персональных данных' });
      const key = req.ip || 'x';
      if (tgLimiter.blocked(key)) return loginPage(req, res, 429, { tab: 'tg', next: nx, error: 'Слишком часто. Подождите несколько минут.' });
      tgLimiter.fail(key);
      let link;
      try { link = await bot.createLink({ purpose: 'login' }); } catch (e) {
        console.warn('[tgbot]', e.message);
        return loginPage(req, res, 502, { tab: 'tg', next: nx, error: 'Не удалось связаться с Telegram. Попробуйте позже или войдите другим способом.' });
      }
      loginPage(req, res, 200, { tab: 'tg', next: nx, tg: { step: 'wait', token: link.token, url: link.url } });
    } catch (e) { next(e); }
  });

  app.post('/login/telegram/verify', shopCtx, async (req, res, next) => {
    try {
      if (!bot.enabled()) return notFound(res);
      const nx = safeNext(req.body.next);
      const tok = String(req.body.token || '').slice(0, 80);
      const wait = async (status, error) => loginPage(req, res, status, { tab: 'tg', next: nx, error, tg: { step: 'wait', token: tok, url: await bot.linkUrl(tok, 'login').catch(() => '#') } });
      const ok = tok && await codes.verify({ purpose: 'tg', target: tok, code: String(req.body.code || '').replace(/\s+/g, '') });
      if (!ok) return wait(422, 'Неверный или просроченный код. Проверьте цифры или откройте бота заново.');
      const { rows } = await db.query(
        `UPDATE webshop.tg_login SET consumed_at = NOW()
          WHERE token = $1 AND purpose = 'login' AND phone IS NOT NULL AND telegram_id IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW() RETURNING phone, telegram_id`, [tok]);
      if (!rows[0]) return wait(422, 'Ссылка устарела. Нажмите «Войти через Telegram» заново.');
      let created;
      try {
        ({ created } = await startSession(req, res, rows[0].phone, { telegramId: rows[0].telegram_id }));
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        return loginPage(req, res, 422, { tab: 'tg', next: nx, error: e.message });
      }
      res.redirect(created && !nx ? '/account/welcome' : (nx || '/account'));
    } catch (e) { next(e); }
  });

  // ---------- Почта и пароль ----------
  app.post('/login/password', shopCtx, async (req, res, next) => {
    try {
      const nx = safeNext(req.body.next);
      const login = String(req.body.login || '').trim().slice(0, 120);
      const password = String(req.body.password || '').slice(0, 200);
      const who = `acc:${normalizePhone(login) || login.toLowerCase()}`;
      const pair = `${req.ip || 'x'}|${who}`;
      const show = (status, error) => loginPage(req, res, status, { tab: 'pw', next: nx, login, error });
      if (loginLimiter.blocked(who) || loginLimiter.blocked(pair)) return show(429, 'Слишком много попыток. Подождите 15 минут или войдите по коду.');
      const customer = await accounts.byLogin(login);
      const ok = customer ? accounts.checkPassword(customer, password) : (verifyPassword(password, DUMMY_HASH), false);
      if (!ok) { loginLimiter.fail(who); loginLimiter.fail(pair); return show(422, 'Неверный логин или пароль'); }
      loginLimiter.reset(who); loginLimiter.reset(pair);
      const token = await sessions.create(customer.id, { ip: req.ip || '', ua: req.get('user-agent') || '' });
      res.cookie(sessions.cookieName, token, cookieOpts(cfg.customer.sessionDays * 86400_000));
      await accounts.touchLogin(customer.id);
      res.redirect(nx || '/account');
    } catch (e) { next(e); }
  });

  // ---------- Письма: сброс пароля и подтверждение почты ----------
  const sendMail = (msg) => { mail.send(msg).catch((e) => console.warn('[mail]', e.message)); };   // не ждём: ответ не зависит от почты

  async function sendVerifyEmail(req, customer) {
    if (!mail.enabled() || !customer.email) return;
    try {
      const { token } = await codes.issueToken({ purpose: 'verify-email', target: `${customer.id}:${customer.email.toLowerCase()}`, hours: 72, ip: req.ip || '' });
      sendMail({ to: customer.email, subject: `Подтвердите почту на ${req.ctx.settings.shopName}`,
        text: `Здравствуйте!\n\nЧтобы подтвердить почту, откройте ссылку (действует 3 дня):\n${req.ctx.baseUrl}/login/verify-email/${token}\n\nЕсли это были не вы, просто проигнорируйте письмо.` });
    } catch (e) { if (!(e instanceof CodeError)) throw e; }
  }

  app.get('/login/forgot', shopCtx, (req, res) => {
    if (!loginOn()) return notFound(res);
    if (req.customer) return res.redirect('/account/password');
    page(req, res, 200, 'Забыли пароль', views.forgotView({ channels: { tg: bot.enabled(), sms: sms.enabled(), mail: mail.enabled() } }));
  });

  app.post('/login/forgot/mail', shopCtx, async (req, res, next) => {
    try {
      if (!loginOn() || !mail.enabled()) return notFound(res);
      const key = req.ip || 'x';
      const channels = { tg: bot.enabled(), sms: sms.enabled(), mail: true };
      if (forgotLimiter.blocked(key)) return page(req, res, 429, 'Забыли пароль', views.forgotView({ channels, error: 'Слишком часто. Попробуйте через несколько минут.' }));
      forgotLimiter.fail(key);
      const customer = await accounts.byLogin(String(req.body.login || '').slice(0, 120));
      // Ответ одинаков для любого адресата; письмо уходит только на подтверждённую почту существующего аккаунта
      if (customer && customer.email && customer.email_verified_at) {
        try {
          const { token } = await codes.issueToken({ purpose: 'reset-mail', target: String(customer.id), hours: 1, ip: req.ip || '' });
          sendMail({ to: customer.email, subject: `Сброс пароля на ${req.ctx.settings.shopName}`,
            text: `Здравствуйте!\n\nВы (или кто-то другой) попросили сбросить пароль на сайте ${req.ctx.settings.shopName}.\nЧтобы задать новый пароль, откройте ссылку (действует час):\n${req.ctx.baseUrl}/login/reset/${token}\n\nЕсли это были не вы, просто проигнорируйте письмо: пароль не изменится.` });
        } catch (e) { if (!(e instanceof CodeError)) throw e; }
      }
      page(req, res, 200, 'Проверьте почту', views.forgotView({ channels, sent: true }));
    } catch (e) { next(e); }
  });

  // Страница по ссылке из письма только показывает кнопку: почтовые сканеры открывают ссылки сами и не должны гасить её
  app.get('/login/reset/:token', shopCtx, (req, res) => {
    page(req, res, 200, 'Новый пароль', views.resetView({ token: String(req.params.token).slice(0, 100) }));
  });

  app.post('/login/reset', shopCtx, async (req, res, next) => {
    try {
      const target = await codes.consumeToken({ purpose: 'reset-mail', token: String(req.body.token || '') });
      const customer = target ? await accounts.byId(Number(target)) : null;
      if (!customer) return page(req, res, 422, 'Ссылка устарела', views.messageView({ title: 'Ссылка устарела', text: 'Ссылка уже использована или её срок вышел. Запросите новую на странице «Забыли пароль».' }));
      const token = await sessions.create(customer.id, { ip: req.ip || '', ua: req.get('user-agent') || '', fresh: true });
      res.cookie(sessions.cookieName, token, cookieOpts(cfg.customer.sessionDays * 86400_000));
      await accounts.touchLogin(customer.id);
      res.redirect('/account/password');
    } catch (e) { next(e); }
  });

  app.get('/login/verify-email/:token', shopCtx, async (req, res, next) => {
    try {
      const target = await codes.consumeToken({ purpose: 'verify-email', token: String(req.params.token).slice(0, 100) });
      const m = /^(\d+):(.+)$/.exec(target || '');
      const customer = m ? await accounts.byId(Number(m[1])) : null;
      if (!customer || customer.email.toLowerCase() !== m[2]) {
        return page(req, res, 410, 'Ссылка устарела', views.messageView({ title: 'Ссылка устарела', text: 'Ссылка уже использована или адрес почты в аккаунте изменился. Запросите подтверждение заново в профиле.' }));
      }
      await accounts.markEmailVerified(customer.id);
      page(req, res, 200, 'Почта подтверждена', views.messageView({ title: 'Почта подтверждена', text: 'Теперь на неё можно получить ссылку для сброса пароля.' }));
    } catch (e) { next(e); }
  });

  // ---------- Кабинет и выход ----------
  app.post('/account/logout', async (req, res, next) => {
    try {
      await sessions.destroy(req.cookies[sessions.cookieName]);
      res.clearCookie(sessions.cookieName, cookieOpts());
      res.redirect('/');
    } catch (e) { next(e); }
  });

  // Все страницы кабинета: без входа - на форму входа с возвратом сюда
  const needLogin = (req, res) => {
    if (!loginOn()) { notFound(res); return true; }
    if (req.customer) return false;
    res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
    return true;
  };

  const fmt = dateFmt(cfg.tz);

  app.get('/account', shopCtx, async (req, res, next) => {
    try {
      if (needLogin(req, res)) return;
      const orders = (await db.query(
        'SELECT number, token, status, total, created_at FROM webshop.orders WHERE customer_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50', [req.customer.id])).rows;
      page(req, res, 200, 'Личный кабинет', views.accountHome({
        customer: req.customer, status: req.ctx.customer.status, orders, fmt, shopName: req.ctx.settings.shopName, botOn: bot.enabled(),
      }));
    } catch (e) { next(e); }
  });

  // ---------- Telegram в кабинете ----------
  const tgGuard = (req, res) => {
    if (!bot.enabled()) { notFound(res); return true; }
    return needLogin(req, res);
  };

  app.get('/account/telegram', shopCtx, (req, res) => {
    if (tgGuard(req, res)) return;
    page(req, res, 200, 'Telegram', views.telegramView({ customer: req.customer, saved: req.query.saved === '1' }));
  });

  app.post('/account/telegram/link', shopCtx, async (req, res, next) => {
    try {
      if (tgGuard(req, res)) return;
      const key = req.ip || 'x';
      if (tgLimiter.blocked(key)) return page(req, res, 429, 'Telegram', views.telegramView({ customer: req.customer, error: 'Слишком часто. Подождите несколько минут.' }));
      tgLimiter.fail(key);
      let link;
      try { link = await bot.createLink({ purpose: 'link', customerId: req.customer.id }); } catch (e) {
        console.warn('[tgbot]', e.message);
        return page(req, res, 502, 'Telegram', views.telegramView({ customer: req.customer, error: 'Не удалось связаться с Telegram. Попробуйте позже.' }));
      }
      page(req, res, 200, 'Telegram', views.telegramView({ customer: req.customer, step: 'wait', token: link.token, url: link.url }));
    } catch (e) { next(e); }
  });

  app.post('/account/telegram/verify', shopCtx, async (req, res, next) => {
    try {
      if (tgGuard(req, res)) return;
      const tok = String(req.body.token || '').slice(0, 80);
      const wait = async (status, error) => page(req, res, status, 'Telegram', views.telegramView({
        customer: req.customer, step: 'wait', token: tok, url: await bot.linkUrl(tok, 'link').catch(() => '#'), error }));
      const ok = tok && await codes.verify({ purpose: 'tg', target: tok, code: String(req.body.code || '').replace(/\s+/g, '') });
      if (!ok) return wait(422, 'Неверный или просроченный код. Проверьте цифры или откройте бота заново.');
      const { rows } = await db.query(
        `UPDATE webshop.tg_login SET consumed_at = NOW()
          WHERE token = $1 AND purpose = 'link' AND customer_id = $2 AND phone = $3 AND telegram_id IS NOT NULL AND consumed_at IS NULL AND expires_at > NOW()
          RETURNING telegram_id`, [tok, req.customer.id, req.customer.phone]);
      if (!rows[0]) return wait(422, 'Ссылка не подходит или устарела. Нажмите «Привязать Telegram» заново.');
      try {
        await accounts.bindTelegram(req.customer.id, rows[0].telegram_id);
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        return page(req, res, 422, 'Telegram', views.telegramView({ customer: req.customer, error: e.message }));
      }
      res.redirect('/account/telegram?saved=1');
    } catch (e) { next(e); }
  });

  app.post('/account/telegram/unlink', shopCtx, async (req, res, next) => {
    try {
      if (tgGuard(req, res)) return;
      await accounts.unbindTelegram(req.customer.id);
      res.redirect('/account/telegram');
    } catch (e) { next(e); }
  });

  app.post('/account/telegram/notify', shopCtx, async (req, res, next) => {
    try {
      if (tgGuard(req, res)) return;
      await accounts.setTelegramNotify(req.customer.id, req.body.on === '1');
      res.redirect('/account/telegram?saved=1');
    } catch (e) { next(e); }
  });

  // Первый вход нового аккаунта: пароль и почта (можно пропустить)
  app.get('/account/welcome', shopCtx, (req, res) => {
    if (needLogin(req, res)) return;
    page(req, res, 200, 'Добро пожаловать', views.welcomeView({ email: req.customer.email }));
  });

  app.post('/account/welcome', shopCtx, async (req, res, next) => {
    try {
      if (needLogin(req, res)) return;
      const email = String(req.body.email || '').trim();
      const password = String(req.body.password || '');
      const show = (error) => page(req, res, 422, 'Добро пожаловать', views.welcomeView({ email, error }));
      if (password && password !== String(req.body.password2 || '')) return show('Пароли не совпадают');
      try {
        if (email) await accounts.setProfile(req.customer.id, { name: '', email });
        if (password) await accounts.setPassword(req.customer.id, password);
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        return show(e.message);
      }
      if (email) await sendVerifyEmail(req, await accounts.byId(req.customer.id));
      res.redirect('/account');
    } catch (e) { next(e); }
  });

  app.get('/account/profile', shopCtx, (req, res) => {
    if (needLogin(req, res)) return;
    page(req, res, 200, 'Профиль', views.profileView({ customer: req.customer, saved: req.query.saved === '1', mailOn: mail.enabled() }));
  });

  app.post('/account/profile', shopCtx, async (req, res, next) => {
    try {
      if (needLogin(req, res)) return;
      const before = req.customer.email.toLowerCase();
      let updated;
      try {
        updated = await accounts.setProfile(req.customer.id, { name: req.body.name, email: req.body.email });
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        return page(req, res, 422, 'Профиль', views.profileView({ customer: { ...req.customer, name: String(req.body.name || ''), email: String(req.body.email || '') }, error: e.message, mailOn: mail.enabled() }));
      }
      if (updated.email && updated.email.toLowerCase() !== before) await sendVerifyEmail(req, updated);
      res.redirect('/account/profile?saved=1');
    } catch (e) { next(e); }
  });

  // Пароль: старый нужен, если он есть и сессия не «свежая» (не по коду или ссылке из письма)
  app.get('/account/password', shopCtx, (req, res) => {
    if (needLogin(req, res)) return;
    const hasPassword = Boolean(req.customer.password_hash);
    page(req, res, 200, hasPassword ? 'Смена пароля' : 'Задать пароль', views.passwordView({ hasPassword, needOld: hasPassword && !req.customerSession.fresh, saved: req.query.saved === '1' }));
  });

  app.post('/account/password', shopCtx, async (req, res, next) => {
    try {
      if (needLogin(req, res)) return;
      const hasPassword = Boolean(req.customer.password_hash);
      const needOld = hasPassword && !req.customerSession.fresh;
      const show = (status, error) => page(req, res, status, 'Смена пароля', views.passwordView({ hasPassword, needOld, error }));
      const key = `pw:${req.customer.id}`;
      if (needOld) {
        if (loginLimiter.blocked(key)) return show(429, 'Слишком много попыток. Подождите 15 минут.');
        if (!accounts.checkPassword(req.customer, String(req.body.old || ''))) { loginLimiter.fail(key); return show(422, 'Текущий пароль неверный'); }
      }
      const password = String(req.body.password || '');
      if (password !== String(req.body.password2 || '')) return show(422, 'Пароли не совпадают');
      try {
        await accounts.setPassword(req.customer.id, password);
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        return show(422, e.message);
      }
      // После смены пароля закрываем все сессии, текущему устройству выдаём новую
      await sessions.destroyAll(req.customer.id);
      const token = await sessions.create(req.customer.id, { ip: req.ip || '', ua: req.get('user-agent') || '' });
      res.cookie(sessions.cookieName, token, cookieOpts(cfg.customer.sessionDays * 86400_000));
      res.redirect('/account/password?saved=1');
    } catch (e) { next(e); }
  });

  // Ссылка «обработка персональных данных» в формах входа ведёт сюда. Политика, опубликованная в админке («Страницы» → privacy),
  // главнее заготовки; пока её нет, показываем заготовку с продавцом из реквизитов и «Сведений о продавце».
  app.get('/privacy', shopCtx, async (req, res, next) => {
    try {
      const p = await pages.bySlug('privacy');
      if (p && p.published && p.body.trim()) return res.redirect(302, '/info/privacy');
      const s = req.ctx.settings;
      const r = (s.payment && s.payment.requisites) || {};
      const legal = s.legal || {};
      const operator = [sellerName(r.name), r.inn && `ИНН ${r.inn}`, legal.ogrnip && `ОГРНИП ${legal.ogrnip}`, legal.address].filter(Boolean).join(', ');
      send(req, res, { title: 'Политика обработки персональных данных', body: views.privacyPage({ shopName: s.shopName, email: s.email, operator }) });
    } catch (e) { next(e); }
  });

  return { safeNext, page, needLogin, startSession, loginOn };
};
