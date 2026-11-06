'use strict';
// Оплата картой: переход на страницу банка и приём уведомления банка о статусе платежа.
const express = require('express');
const { getOrderByToken } = require('../orders');
const { PayError, UNPAID } = require('../payments');

module.exports = function mount(app, { db, payments }) {
  // Ссылкой, а не формой: после отправки формы браузер не пустит редирект на чужой адрес (form-action 'self' в CSP)
  app.get('/order/:number/pay/card', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const t = String(req.query.t || '');
      const o = await getOrderByToken(db, req.params.number, t);
      if (!o) return res.status(404).type('text').send('Заказ не найден');
      const back = `/order/${o.number}?t=${encodeURIComponent(t)}`;
      if (!UNPAID.includes(o.status)) return res.redirect(303, back);
      try {
        res.redirect(303, await payments.startCard(o));
      } catch (e) {
        if (!(e instanceof PayError)) throw e;
        console.warn(`[pay] заказ ${o.number}: ${e.message}`);
        res.redirect(303, `${back}&payerr=1`);
      }
    } catch (e) { next(e); }
  });

  // Уведомление банка: JSON с подписью Token. Банк ждёт ответ «OK», иначе повторяет отправку.
  app.post('/pay/tbank/notify', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const r = await payments.handleNotify(req.body);
      if (r === 'bad') return res.status(403).type('text').send('bad token');
      res.type('text').send('OK');
    } catch (e) {
      console.error('[pay] уведомление банка:', e.message);
      res.status(500).type('text').send('error');
    }
  });
};
