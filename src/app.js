'use strict';
const path = require('path');
const express = require('express');
const { html } = require('./html');
const sec = require('./security');
const { Catalog } = require('./catalog');
const { createSettings } = require('./settings');
const { createDelivery } = require('./delivery');
const { createCarts } = require('./cart');
const { createTracker } = require('./track');
const { createWriteoff } = require('./writeoff');
const { createNotifier } = require('./notify');
const { createCarriers } = require('./carriers');
const { currentSeason, SEASONS } = require('./seasons');
const { DEPARTMENTS } = require('./model');
const { createMedia } = require('./media');
const { shopPage } = require('./shopviews');
const { icon } = require('./icons');

const ASSET_V = Date.now().toString(36);

function createApp(cfg, db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  const settings = createSettings(db, cfg);
  const catalog = new Catalog(db, cfg, settings);
  const delivery = createDelivery(db);
  const carts = createCarts(db);
  const tracker = createTracker(db, cfg);
  const media = createMedia(db);
  const writeoff = createWriteoff(db);
  const notifier = createNotifier({ db, cfg });
  const carriers = createCarriers(cfg, { fetchImpl: opts.fetchImpl });
  const services = { cfg, db, settings, catalog, delivery, carts, tracker, media, writeoff, notifier, carriers };
  app.locals.services = services;

  // --- Заголовки безопасности. Скрипты и стили - только свои файлы (без inline).
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
        "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (cfg.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: cfg.prod ? '7d' : 0, index: false }));
  media.mount(app);
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));
  app.get('/robots.txt', (req, res) => {
    res.type('text').send(`User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /order\nDisallow: /api\n` +
      (cfg.publicUrl ? `Sitemap: ${cfg.publicUrl}/sitemap.xml\n` : ''));
  });

  app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 400 }));
  app.use((req, res, next) => { req.body ??= {}; next(); });

  // Защита от межсайтовых POST: браузер сам сообщает, откуда пришёл запрос.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const site = req.get('sec-fetch-site');
    let ok = true;
    if (site) ok = site === 'same-origin' || site === 'none';
    else if (req.get('origin')) {
      try { ok = new URL(req.get('origin')).host === req.get('host'); } catch { ok = false; }
    }
    if (!ok) return res.status(403).type('text').send('Запрос отклонён (межсайтовый запрос)');
    next();
  });

  // Cookie разбираем один раз; дальше они нужны и витрине, и админке.
  app.use((req, res, next) => { req.cookies = sec.parseCookies(req.headers.cookie); next(); });

  // Контекст страницы витрины: настройки, сезон, отделы, число товаров в корзине.
  const cartName = cfg.secureCookies ? '__Host-cart' : 'cart';
  const cartCountName = cfg.secureCookies ? '__Host-cc' : 'cc';
  const cookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, path: '/', ...(maxAge ? { maxAge } : {}) });
  app.locals.cookies = { cartName, cartCountName, cookieOpts };

  const shopCtx = async (req, res, next) => {
    try {
      await catalog.ensure();
      const s = await settings.get();
      const d = await delivery.all();
      const baseUrl = cfg.publicUrl || `${req.protocol}://${req.get('host')}`;
      const deptCounts = {};
      for (const dd of Object.values(DEPARTMENTS)) deptCounts[dd.slug] = 0;
      let saleCount = 0;
      for (const m of catalog.models) if (m.inStock) { deptCounts[DEPARTMENTS[m.dept].slug]++; if (m.oldPrice) saleCount++; }
      const frees = d.methods.filter((m) => m.active && m.free_from !== null).map((m) => m.free_from);
      req.ctx = {
        settings: s,
        // Администратор может посмотреть другой сезон: /?preview_season=winter
        season: SEASONS[req.query.preview_season] && app.locals.adminPeek && app.locals.adminPeek(req) ? req.query.preview_season : currentSeason(s, new Date(), cfg.tz),
        deptCounts,
        saleCount,
        dept: String(req.query.dept || ''),
        cartCount: Math.max(0, Math.min(99, parseInt(req.cookies[cartCountName], 10) || 0)),
        freeFrom: frees.length ? Math.min(...frees) : 0,
        baseUrl,
        assetV: ASSET_V,
        deliveryData: d,
      };
      res.locals.ctx = req.ctx;
      next();
    } catch (e) { next(e); }
  };
  app.locals.shopCtx = shopCtx;

  const send = (req, res, view, status = 200) => {
    res.status(status).type('html').send(shopPage(req.ctx, view).toString());
  };
  app.locals.send = send;

  require('./routes/shop')(app, services, shopCtx, send);
  require('./routes/cart')(app, services, shopCtx, send);
  require('./admin/routes')(app, services);

  // 404 и ошибки: оформленные страницы витрины
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/admin') || req.path.startsWith('/api') || req.path.startsWith('/media')) return res.status(404).type('text').send('Не найдено');
    shopCtx(req, res, (err) => {
      if (err) return next(err);
      send(req, res, {
        title: 'Страница не найдена', noindex: true, bodyClass: 'page-plain',
        body: html`<section class="wrap empty"><p class="eyebrow">404</p><h1>Такой страницы нет</h1><p>Возможно, модель уже раскупили или ссылка устарела.</p>
          <p><a class="btn" href="/catalog">В каталог ${icon('arrow-right')}</a></p></section>`,
      }, 404);
    });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', req.method, req.originalUrl, err);
    if (res.headersSent) return;
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Ошибка сервера' });
    res.status(500).type('text').send('Что-то пошло не так. Попробуйте ещё раз через минуту.');
  });

  app.locals.shutdown = async () => { writeoff.stop(); await notifier.stop(); await tracker.flush(); };
  return app;
}

module.exports = { createApp };
