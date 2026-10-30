'use strict';
// Вход в админку. Пользователи админки хранятся в webshop.admin_users и не связаны с пользователями приложения «Склад».
// Роли: owner - всё; manager - заказы, клиенты, статистика; editor - витрина и каталог (без денег и клиентов).
const sec = require('../security');
const { html } = require('../html');

const ROLES = {
  owner: { title: 'Владелец', hint: 'Полный доступ: заказы, клиенты, настройки, доставка, пользователи' },
  manager: { title: 'Менеджер', hint: 'Заказы, клиенты и статистика' },
  editor: { title: 'Контент-менеджер', hint: 'Витрина, сезонные подборки и каталог без доступа к деньгам и клиентам' },
};

// Какие разделы доступны каким ролям
const ACCESS = {
  dashboard: ['owner', 'manager'],
  orders: ['owner', 'manager'],
  customers: ['owner', 'manager'],
  traffic: ['owner', 'manager'],
  showcase: ['owner', 'editor'],
  delivery: ['owner'],
  users: ['owner'],
  settings: ['owner'],
  account: ['owner', 'manager', 'editor'],
};
const can = (role, section) => (ACCESS[section] || []).includes(role);
const homeFor = (role) => (can(role, 'dashboard') ? '/admin' : can(role, 'showcase') ? '/admin/showcase' : '/admin/account');

function createAuth({ cfg, db }) {
  const cookieName = cfg.secureCookies ? '__Host-admin' : 'admin';
  const flashName = cfg.secureCookies ? '__Host-aflash' : 'aflash';
  const opts = (maxAge) => ({ httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/', ...(maxAge ? { maxAge } : {}) });
  const limiter = new sec.RateLimiter(8, 15 * 60_000);
  const maxAgeMs = cfg.sessionHours * 3600_000;

  function startSession(res, user, sid = sec.randomId(12)) {
    const token = sec.sign(cfg.secret, { uid: user.id, v: sec.passwordVersion(user), sid, exp: Date.now() + maxAgeMs });
    res.cookie(cookieName, token, opts(maxAgeMs));
  }

  // Только проверка подписи cookie, без запроса в базу: нужно витрине, чтобы разрешить просмотр сезонов администратору
  function peek(req) {
    const s = sec.unsign(cfg.secret, (req.cookies || {})[cookieName]);
    return s && typeof s.uid === 'number' && s.exp > Date.now() ? s : null;
  }

  // Контекст админки: пользователь, csrf, одноразовое сообщение
  async function attach(req, res, next) {
    try {
      const a = { user: null, csrf: '', flash: null };
      req.admin = a;
      const flash = sec.unsign(cfg.secret, req.cookies[flashName]);
      if (flash) {
        a.flash = { kind: flash.k === 'err' ? 'err' : 'ok', text: String(flash.t || '') };
        res.clearCookie(flashName, opts());
      }
      res.flash = (kind, text) => res.cookie(flashName, sec.sign(cfg.secret, { k: kind, t: text }), opts(60_000));
      const s = peek(req);
      if (s) {
        const { rows } = await db.query('SELECT id, username, display_name, role, active, password_hash FROM webshop.admin_users WHERE id = $1', [s.uid]);
        const u = rows[0];
        if (u && u.active && s.v === sec.passwordVersion(u)) {
          a.user = { id: u.id, username: u.username, name: u.display_name || u.username, role: u.role };
          a.session = s;
          a.csrf = sec.csrfToken(cfg.secret, s);
          if (s.exp - Date.now() < maxAgeMs / 2) startSession(res, u, s.sid);
        }
      }
      res.set('Cache-Control', 'no-store');
      next();
    } catch (e) { next(e); }
  }

  // Требует вход и нужный раздел; для POST проверяет csrf
  const require_ = (section) => (req, res, next) => {
    const a = req.admin;
    if (!a.user) {
      if (req.method === 'GET') return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
      return res.redirect('/admin/login');
    }
    if (section && !can(a.user.role, section)) {
      return res.status(403).type('html').send(req.app.locals.adminForbidden(req));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!sec.safeEqual(req.body._csrf ?? '', a.csrf)) return res.status(403).type('html').send(req.app.locals.adminStale(req));
    }
    next();
  };

  async function login(req, username, password) {
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    if (limiter.blocked(key)) return { error: 'Слишком много попыток входа. Подождите 15 минут.' };
    const { rows } = await db.query('SELECT id, username, password_hash, active FROM webshop.admin_users WHERE username = $1', [String(username).trim().toLowerCase()]);
    const u = rows[0];
    // Проверяем пароль и когда пользователя нет: время ответа не выдаёт, какие логины существуют
    const ok = sec.verifyPassword(password, u ? u.password_hash : 'scrypt$00$00') && u && u.active;
    if (!ok) { limiter.fail(key); return { error: 'Неверный логин или пароль' }; }
    limiter.reset(key);
    await db.query('UPDATE webshop.admin_users SET last_login_at = NOW() WHERE id = $1', [u.id]);
    return { user: u };
  }

  const csrfField = (req) => html`<input type="hidden" name="_csrf" value="${req.admin.csrf}">`;

  return { attach, require: require_, login, startSession, peek, cookieName, opts, csrfField };
}

module.exports = { createAuth, ROLES, ACCESS, can, homeFor };
