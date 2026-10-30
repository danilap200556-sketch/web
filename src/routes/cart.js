'use strict';
const { html, raw } = require('../html');
const { icon } = require('../icons');
const { rub, plural, formatPhone, dateFmt, clampInt } = require('../util');
const sec = require('../security');
const cartLib = require('../cart');
const { quote, PAY_METHODS } = require('../delivery');
const { OrderError, STATUSES, FLOW, validateCheckout, createOrder, getOrderByToken } = require('../orders');
const { photoUrl } = require('../shopviews');

module.exports = function mount(app, { cfg, db, catalog, carts, tracker, delivery }, shopCtx, send) {
  const { cartName, cartCountName, cookieOpts } = app.locals.cookies;
  const fmt = dateFmt(cfg.tz);
  const orderLimiter = new sec.RateLimiter(8, 10 * 60_000);

  const wantsJson = (req) => req.get('x-fetch') === '1' || /json/.test(req.get('accept') || '') && !/html/.test(req.get('accept') || '');
  const setCount = (res, n) => res.cookie(cartCountName, String(n), cookieOpts(60 * 86400_000));
  const token = (req) => (req.cookies[cartName] && req.cookies[cartName].length < 60 ? req.cookies[cartName] : '');

  async function loadCart(req) {
    await catalog.ensure();
    const items = await carts.read(token(req));
    return { items, priced: cartLib.price(catalog, items) };
  }

  // ---------- Корзина ----------
  app.get('/cart', shopCtx, async (req, res, next) => {
    try {
      const ctx = req.ctx;
      tracker.record(req, res, 'page', { path: '/cart' });
      const { items, priced } = await loadCart(req);
      // Приводим корзину в порядок: убираем пропавшее, подрезаем количества
      const tidy = priced.lines.filter((l) => !l.gone).map((l) => ({ pid: l.pid, qty: l.out ? l.requested : Math.max(1, l.qty) }));
      if (tidy.length !== items.length) await carts.write(token(req), tidy);
      setCount(res, priced.count);
      ctx.cartCount = priced.count;
      const free = ctx.freeFrom;
      const left = free ? Math.max(0, free - priced.subtotal) : 0;
      const pct = free ? Math.min(100, Math.round((priced.subtotal / free) * 100)) : 0;
      const lines = priced.lines.filter((l) => !l.gone);
      const body = html`
      <section class="wrap cartpage">
        <h1>Корзина ${lines.length ? html`<span class="muted">${priced.count} ${plural(priced.count, 'товар', 'товара', 'товаров')}</span>` : ''}</h1>
        ${lines.length ? html`
        <div class="cartpage__cols">
          <div class="cartlist">
            ${lines.map((l) => html`<article class="cartline${l.out ? ' is-out' : ''}">
              <a class="cartline__img" href="/p/${l.model.slug}">${l.model.cover ? html`<img src="${photoUrl(l.model.cover, 360)}" alt="" width="360" height="360" loading="lazy">` : ''}</a>
              <div class="cartline__info">
                <a class="cartline__title" href="/p/${l.model.slug}">${l.model.title}</a>
                <p class="muted">${[l.model.type, l.model.colorway].filter(Boolean).join(' · ')}</p>
                <p class="cartline__size">Размер: <b>${l.size.label}</b></p>
                ${l.out ? html`<p class="warn">Этой пары уже нет в наличии - уберите её из корзины</p>` : l.short ? html`<p class="warn">В наличии только ${l.max} шт.</p>` : ''}
              </div>
              <form class="qty" action="/cart/update" method="post" data-qty-form>
                <input type="hidden" name="pid" value="${l.pid}">
                <button class="qty__b" name="qty" value="${Math.max(0, (l.out ? 1 : l.qty) - 1)}" aria-label="Меньше" ${l.out ? raw('disabled') : ''}>${icon('minus')}</button>
                <output>${l.out ? 0 : l.qty}</output>
                <button class="qty__b" name="qty" value="${l.qty + 1}" aria-label="Больше" ${l.out || l.qty >= l.max ? raw('disabled') : ''}>${icon('plus')}</button>
              </form>
              <div class="cartline__sum"><b>${rub(l.sum)}</b>${l.qty > 1 ? html`<span class="muted">${rub(l.price)} за пару</span>` : ''}</div>
              <form action="/cart/update" method="post"><input type="hidden" name="pid" value="${l.pid}"><button class="iconbtn" name="qty" value="0" aria-label="Убрать">${icon('trash')}</button></form>
            </article>`)}
          </div>
          <aside class="summary">
            <h2>Ваш заказ</h2>
            <dl class="sumrows"><dt>Товары</dt><dd>${rub(priced.subtotal)}</dd><dt>Доставка</dt><dd class="muted">рассчитаем на следующем шаге</dd></dl>
            ${free ? html`<div class="freebar">
              <p>${left > 0 ? html`До бесплатной доставки осталось <b>${rub(left)}</b>` : html`${icon('check')} Бесплатная доставка включена`}</p>
              <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="freebar__bg" width="100" height="6" rx="3"/><rect class="freebar__fg" width="${pct}" height="6" rx="3"/></svg>
            </div>` : ''}
            <a class="btn btn--lg btn--block${priced.count ? '' : ' is-disabled'}" href="/checkout">Оформить заказ ${icon('arrow-right')}</a>
            <a class="link link--center" href="/catalog">Продолжить покупки</a>
          </aside>
        </div>` : html`
        <div class="empty"><p class="eyebrow">Пока пусто</p><h2>В корзине ничего нет</h2><p>Выберите пару в каталоге: размер и цену подскажем на странице модели.</p>
          <p><a class="btn" href="/catalog">Перейти в каталог ${icon('arrow-right')}</a></p></div>`}
      </section>`;
      send(req, res, { title: 'Корзина', body, bodyClass: 'page-cart', noindex: true });
    } catch (e) { next(e); }
  });

  app.post('/cart/add', async (req, res, next) => {
    try {
      await catalog.ensure();
      const pid = parseInt(req.body.pid, 10);
      const hit = catalog.byProduct.get(pid);
      const json = wantsJson(req);
      const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') && !req.body.back.startsWith('//') ? req.body.back : '/cart';
      if (!hit || hit.model.hidden || hit.size.qty <= 0) {
        if (json) return res.status(409).json({ ok: false, error: 'Этого размера уже нет в наличии' });
        return res.redirect(back);
      }
      let t = token(req);
      if (!t) { t = sec.randomId(18); res.cookie(cartName, t, cookieOpts(60 * 86400_000)); }
      const items = await carts.read(t);
      const cur = items.find((i) => i.pid === pid);
      if (cur && cur.qty >= hit.size.qty) {
        const priced0 = cartLib.price(catalog, items);
        if (json) return res.status(409).json({ ok: false, error: `В наличии только ${hit.size.qty} шт.`, count: priced0.count });
        return res.redirect('/cart');
      }
      const next_ = cartLib.add(items, pid, clampInt(req.body.qty, 1, cartLib.MAX_QTY, 1));
      await carts.write(t, next_);
      const priced = cartLib.price(catalog, next_);
      setCount(res, priced.count);
      tracker.record(req, res, 'cart_add', { path: `/p/${hit.model.slug}`, model_key: hit.model.key });
      if (json) {
        return res.json({
          ok: true, count: priced.count, subtotal: rub(priced.subtotal),
          item: { title: hit.model.title, size: hit.size.label, price: rub(hit.size.price), img: hit.model.cover ? photoUrl(hit.model.cover, 360) : '' },
        });
      }
      res.redirect('/cart');
    } catch (e) { next(e); }
  });

  app.post('/cart/update', async (req, res, next) => {
    try {
      await catalog.ensure();
      const t = token(req);
      const pid = parseInt(req.body.pid, 10);
      if (t && Number.isInteger(pid)) {
        const items = cartLib.setQty(await carts.read(t), pid, clampInt(req.body.qty, 0, cartLib.MAX_QTY, 1));
        await carts.write(t, items);
        setCount(res, cartLib.price(catalog, items).count);
      }
      if (wantsJson(req)) return res.json({ ok: true });
      res.redirect('/cart');
    } catch (e) { next(e); }
  });

  // ---------- Оформление ----------
  const emptyForm = () => ({ name: '', phone: '', email: '', delivery: '', mode: 'point', city: '', address: '', tcpoint: '', point: '', pay: '', comment: '', consent: '' });

  async function renderCheckout(req, res, { form = emptyForm(), error = '', status = 200 } = {}) {
    const ctx = req.ctx;
    const { priced } = await loadCart(req);
    if (!priced.count) return res.redirect('/cart');
    setCount(res, priced.count);
    const lines = priced.lines.filter((l) => !l.gone && !l.out && l.qty > 0);
    const d = ctx.deliveryData;
    const methods = d.methods.filter((m) => m.active);
    const points = d.points.filter((p) => p.active);
    if (!form.delivery && methods[0]) form.delivery = methods[0].code;
    if (!form.point && points[0]) form.point = String(points[0].id);
    if (!form.pay) form.pay = 'online';
    const idem = sec.randomId(12);
    const sel = methods.find((m) => m.code === form.delivery) || methods[0];
    const selDoor = sel && (sel.kind === 'courier' || (sel.kind === 'tc' && form.mode === 'door'));
    const selQ = sel ? quote(sel, priced.subtotal, selDoor) : { price: 0 };
    const kindIcon = { pickup: 'store', courier: 'truck', tc: 'box' };
    const body = html`
    <section class="wrap checkout">
      <nav class="crumbs"><a href="/cart">Корзина</a>${icon('chevron-right')}<span>Оформление</span></nav>
      <h1>Оформление заказа</h1>
      ${error ? html`<div class="alert alert--err" role="alert">${error}</div>` : ''}
      <form class="checkout__cols" action="/checkout" method="post" data-checkout>
        <input type="hidden" name="idem" value="${idem}">
        <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="checkout__main">
          <fieldset class="step">
            <legend><span class="step__n">1</span> Контакты</legend>
            <div class="fields">
              <label class="field">Имя<input name="name" value="${form.name}" autocomplete="name" required maxlength="80" placeholder="Как к вам обращаться"></label>
              <label class="field">Телефон<input name="phone" value="${form.phone}" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 900 123-45-67" data-phone></label>
              <label class="field field--wide">Электронная почта <span class="muted">(необязательно)</span><input name="email" value="${form.email}" type="email" autocomplete="email" placeholder="для чека и уведомлений"></label>
            </div>
          </fieldset>

          <fieldset class="step">
            <legend><span class="step__n">2</span> Доставка</legend>
            <div class="options" role="radiogroup">
              ${methods.map((m) => {
                const q = quote(m, priced.subtotal, m.kind === 'courier');
                return html`<label class="option" data-method data-kind="${m.kind}" data-price="${m.price}" data-door-extra="${m.door_extra}" data-free-from="${m.free_from ?? ''}" data-cities="${m.cities}">
                  <input type="radio" name="delivery" value="${m.code}" ${form.delivery === m.code ? raw('checked') : ''}>
                  <span class="option__ic">${icon(kindIcon[m.kind])}</span>
                  <span class="option__t"><b>${m.title}</b><small>${m.description}${m.eta ? ' · ' + m.eta : ''}</small></span>
                  <span class="option__p" data-method-price>${q.free || !q.price ? 'Бесплатно' : (m.kind === 'tc' ? 'от ' : '') + rub(q.price)}</span>
                </label>`;
              })}
            </div>

            <div class="deliv deliv--pickup" data-pane="pickup">
              <p class="deliv__label">Пункт самовывоза</p>
              ${points.map((p) => html`<label class="point"><input type="radio" name="point" value="${p.id}" ${String(form.point) === String(p.id) ? raw('checked') : ''}>
                <span><b>${p.title}</b><small>${p.address}${p.hours ? ' · ' + p.hours : ''}</small></span></label>`)}
            </div>
            <div class="deliv deliv--address" data-pane="address">
              <div class="fields">
                <label class="field">Город<input name="city" value="${form.city}" autocomplete="address-level2" placeholder="Например, Москва" data-city></label>
                <div class="field" data-tc-mode>
                  <span class="field__l">Куда доставить</span>
                  <div class="seg seg--sm"><label><input type="radio" name="mode" value="point" ${form.mode !== 'door' ? raw('checked') : ''}><span>В пункт выдачи</span></label>
                    <label><input type="radio" name="mode" value="door" ${form.mode === 'door' ? raw('checked') : ''}><span>До двери</span></label></div>
                </div>
                <label class="field field--wide" data-field-address>Адрес доставки<input name="address" value="${form.address}" autocomplete="street-address" placeholder="Улица, дом, квартира, подъезд, этаж"></label>
                <label class="field field--wide" data-field-tcpoint>Пункт выдачи<input name="tcpoint" value="${form.tcpoint}" placeholder="Адрес пункта или его номер: подскажем, если не знаете"></label>
              </div>
              <p class="hint" data-city-hint hidden></p>
            </div>
          </fieldset>

          <fieldset class="step">
            <legend><span class="step__n">3</span> Оплата</legend>
            <div class="options options--2">
              ${Object.entries(PAY_METHODS).map(([code, p]) => html`<label class="option" data-pay="${code}">
                <input type="radio" name="pay" value="${code}" ${form.pay === code ? raw('checked') : ''}>
                <span class="option__ic">${icon(p.icon)}</span>
                <span class="option__t"><b>${p.title}</b><small>${p.hint}</small></span></label>`)}
            </div>
            <p class="hint" data-pay-hint hidden>Для доставки транспортной компанией нужна онлайн-оплата.</p>
          </fieldset>

          <fieldset class="step">
            <legend><span class="step__n">4</span> Комментарий</legend>
            <label class="field field--wide"><textarea name="comment" rows="2" maxlength="500" placeholder="Удобное время, домофон, пожелания (необязательно)">${form.comment}</textarea></label>
            <label class="check check--consent"><input type="checkbox" name="consent" value="1" ${form.consent ? raw('checked') : ''} required>
              <span>Согласен на обработку персональных данных и с условиями <a href="/delivery" target="_blank">доставки и возврата</a></span></label>
          </fieldset>
        </div>

        <aside class="summary summary--sticky">
          <h2>Ваш заказ</h2>
          <ul class="mini">
            ${lines.map((l) => html`<li><img src="${photoUrl(l.model.cover, 360)}" alt="" width="64" height="64" loading="lazy"><div><b>${l.model.title}</b><span>Размер ${l.size.label} · ${l.qty} шт.</span></div><i>${rub(l.sum)}</i></li>`)}
          </ul>
          <dl class="sumrows">
            <dt>Товары</dt><dd data-sum-sub data-value="${priced.subtotal}">${rub(priced.subtotal)}</dd>
            <dt>Доставка</dt><dd data-sum-delivery>${selQ.price ? rub(selQ.price) : 'Бесплатно'}</dd>
            <dt class="sumrows__total">Итого</dt><dd class="sumrows__total" data-sum-total>${rub(priced.subtotal + selQ.price)}</dd>
          </dl>
          <button class="btn btn--lg btn--block" type="submit" data-submit>Оформить заказ</button>
          <p class="muted summary__note">Менеджер свяжется с вами, чтобы подтвердить заказ.</p>
        </aside>
      </form>
    </section>`;
    send(req, res, { title: 'Оформление заказа', body, bodyClass: 'page-checkout', noindex: true }, status);
  }

  app.get('/checkout', shopCtx, async (req, res, next) => {
    try {
      const { priced } = await loadCart(req);
      if (priced.count) tracker.record(req, res, 'checkout', { path: '/checkout' });
      await renderCheckout(req, res);
    } catch (e) { next(e); }
  });

  // Пересчёт доставки без перезагрузки страницы
  app.get('/api/quote', shopCtx, async (req, res, next) => {
    try {
      const { priced } = await loadCart(req);
      const m = req.ctx.deliveryData.methods.find((x) => x.code === req.query.delivery && x.active);
      if (!m) return res.status(404).json({ error: 'Нет такого способа' });
      const door = m.kind === 'courier' || (m.kind === 'tc' && req.query.mode === 'door');
      const q = quote(m, priced.subtotal, door);
      res.json({ price: q.price, total: priced.subtotal + q.price, free: q.free });
    } catch (e) { next(e); }
  });

  app.post('/checkout', shopCtx, async (req, res, next) => {
    try {
      const form = { ...emptyForm(), ...Object.fromEntries(Object.entries(req.body).filter(([k]) => k in emptyForm())) };
      for (const k of Object.keys(form)) form[k] = String(form[k] ?? '');
      if (req.body.website) return res.redirect('/'); // ловушка для ботов
      const ip = req.ip || 'x';
      if (orderLimiter.blocked(ip)) return renderCheckout(req, res, { form, error: 'Слишком много попыток. Подождите несколько минут.', status: 429 });
      const { priced } = await loadCart(req);
      if (!priced.count) return res.redirect('/cart');
      const d = req.ctx.deliveryData;
      const lines = priced.lines.filter((l) => !l.gone && !l.out && l.qty > 0);
      const subtotal = lines.reduce((a, l) => a + l.sum, 0);
      let data;
      try {
        data = validateCheckout(form, d.methods, d.points, subtotal);
      } catch (e) {
        if (!(e instanceof OrderError)) throw e;
        return renderCheckout(req, res, { form, error: e.message, status: 422 });
      }
      orderLimiter.fail(ip);
      const who = tracker.who(req);
      await tracker.flush();
      const src = who.sid ? await db.query("SELECT source FROM webshop.visits WHERE sid = $1 AND source <> '' ORDER BY at LIMIT 1", [who.sid]) : { rows: [] };
      let order;
      try {
        order = await createOrder(db, { form: data, priced, catalog, idemKey: String(form.delivery ? req.body.idem || '' : '').slice(0, 40) || null, vid: who.vid, sid: who.sid, source: src.rows[0]?.source || '' });
      } catch (e) {
        if (!(e instanceof OrderError)) throw e;
        return renderCheckout(req, res, { form, error: e.message, status: 409 });
      }
      if (!order.repeated) tracker.record(req, res, 'order', { path: '/checkout' });
      await carts.clear(token(req));
      res.clearCookie(cartName, cookieOpts());
      setCount(res, 0);
      res.redirect(303, `/order/${order.number}?t=${order.token}`);
    } catch (e) { next(e); }
  });

  // ---------- Страница заказа (ссылка с секретным ключом) ----------
  app.get('/order/:number', shopCtx, async (req, res, next) => {
    try {
      const o = await getOrderByToken(db, req.params.number, String(req.query.t || ''));
      res.set('Cache-Control', 'no-store');
      if (!o) {
        return send(req, res, { title: 'Заказ не найден', noindex: true, body: html`<section class="wrap empty"><p class="eyebrow">Заказ не найден</p><h1>Проверьте ссылку</h1><p>Откройте ссылку из сообщения о заказе целиком: в ней есть секретный ключ.</p><p><a class="btn" href="/">На главную</a></p></section>` }, 404);
      }
      const st = STATUSES[o.status];
      const steps = FLOW.map((k) => ({ k, title: STATUSES[k].title, done: st.step >= STATUSES[k].step && st.step >= 0, now: o.status === k }));
      const closed = o.status === 'cancelled' || o.status === 'returned';
      const body = html`
      <section class="wrap orderpage">
        <div class="orderpage__head">
          <p class="chip chip--ok">${icon('check')} ${closed ? st.title : 'Заказ принят'}</p>
          <h1>Заказ № ${o.number}</h1>
          <p class="muted">от ${fmt.dateTime(o.created_at)}. ${o.status === 'new' ? 'Менеджер свяжется с вами в ближайшее время, чтобы подтвердить заказ.' : ''}</p>
        </div>
        ${closed ? html`<div class="alert alert--err">Статус: ${st.title}</div>` : html`<ol class="steps">${steps.map((s) => html`<li class="${s.done ? 'is-done' : ''}${s.now ? ' is-now' : ''}"><span>${s.done ? icon('check') : ''}</span>${s.title}</li>`)}</ol>`}
        ${o.track_number ? html`<p class="alert alert--ok">Трек-номер: <b>${o.track_number}</b></p>` : ''}
        <div class="orderpage__cols">
          <div class="cartlist">
            ${o.items.map((i) => html`<article class="cartline cartline--static">
              <span class="cartline__img">${i.photo_id ? html`<img src="${photoUrl(i.photo_id, 360)}" alt="" width="360" height="360" loading="lazy">` : ''}</span>
              <div class="cartline__info"><span class="cartline__title">${i.title}</span><p class="muted">${i.type}</p><p class="cartline__size">Размер: <b>${i.size}</b> · ${i.qty} шт.</p></div>
              <div class="cartline__sum"><b>${rub(Number(i.price) * i.qty)}</b></div></article>`)}
          </div>
          <aside class="summary">
            <h2>Детали</h2>
            <dl class="sumrows">
              <dt>Товары</dt><dd>${rub(o.subtotal)}</dd>
              <dt>${o.delivery_title}</dt><dd>${Number(o.delivery_cost) ? rub(o.delivery_cost) : 'Бесплатно'}</dd>
              <dt class="sumrows__total">Итого</dt><dd class="sumrows__total">${rub(o.total)}</dd>
            </dl>
            <dl class="facts">
              <dt>Получатель</dt><dd>${o.name}<br>${formatPhone(o.phone)}</dd>
              <dt>${o.delivery_kind === 'pickup' ? 'Самовывоз' : o.delivery_door ? 'Адрес' : 'Пункт выдачи'}</dt><dd>${[o.delivery_city, o.delivery_address || o.delivery_point].filter(Boolean).join(', ')}</dd>
              <dt>Оплата</dt><dd>${PAY_METHODS[o.pay_method]?.title || o.pay_method}</dd>
              ${o.comment ? html`<dt>Комментарий</dt><dd>${o.comment}</dd>` : ''}
            </dl>
            <a class="btn btn--ghost btn--block" href="/catalog">Продолжить покупки</a>
          </aside>
        </div>
      </section>`;
      send(req, res, { title: `Заказ № ${o.number}`, body, bodyClass: 'page-order', noindex: true });
    } catch (e) { next(e); }
  });
};
