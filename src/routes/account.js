'use strict';
// Личный кабинет покупателя: вход (SMS, Telegram, почта и пароль), выход, кабинет.
// Состояние входа лежит в req.customer (его выставляет app.js по cookie сессии).
const { normalizePhone } = require('../util');
const { CodeError } = require('../auth-codes');
const { SmsError } = require('../sms');
const views = require('../accountviews');

module.exports = function mount(app, services, shopCtx, send) {
  const { cfg, settings, accounts, sessions, codes, sms, bot } = services;
  const { cookieOpts } = app.locals.cookies;

  const loginOn = () => sms.enabled() || bot.enabled();
  const tabs = () => [sms.enabled() && 'sms'].filter(Boolean);
  const notFound = (res) => res.status(404).type('text').send('Не найдено');

  // Куда вернуть после входа: только путь на этом же сайте
  const safeNext = (v) => { const s = String(v || ''); return /^\/(?![/\\])[^\s\u0000-\u001f]{0,198}$/.test(s) ? s : ''; };

  // Страницы аккаунта не кэшируются и закрыты от поисковиков
  const page = (req, res, status, title, body) => {
    res.set('Cache-Control', 'no-store');
    send(req, res, { title, noindex: true, bodyClass: 'page-plain', body }, status);
  };

  function loginPage(req, res, status, { tab = 'sms', step = 'phone', phone = '', next = '', error = '' } = {}) {
    const t = tabs();
    const cur = t.includes(tab) ? tab : t[0];
    page(req, res, status, 'Вход', views.loginView({ tabs: t, tab: cur, next, error, panes: { sms: views.smsPane({ step, phone, next }) } }));
  }

  // Подтверждённый телефон -> клиент и «свежая» сессия (пароль можно сменить без старого)
  async function startSession(req, res, phone) {
    const { customer, created } = await accounts.ensureByVerifiedPhone(phone, {});
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
      await startSession(req, res, phone);
      res.redirect(nx || '/account');
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

  app.get('/account', shopCtx, (req, res) => {
    if (needLogin(req, res)) return;
    page(req, res, 200, 'Личный кабинет', views.accountHome({ customer: req.customer }));
  });

  app.get('/privacy', shopCtx, (req, res) => {
    const s = req.ctx.settings;
    const r = s.payment && s.payment.requisites;
    send(req, res, { title: 'Политика обработки персональных данных', body: views.privacyPage({ shopName: s.shopName, email: s.email, operator: r && r.name }) });
  });

  return { safeNext, page, needLogin, startSession, loginOn };
};
