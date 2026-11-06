'use strict';
// Оплата заказов: СБП (QR НСПК по ссылке из настроек), перевод по реквизитам и карта онлайн через эквайринг ТБанка.
// Сайт не принимает деньги сам: СБП и перевод идут на счёт ИП из реквизитов, карта - на расчётный счёт по договору эквайринга.
// Поступление подтверждает менеджер («Оплачен» в админке); карта подтверждается автоматически уведомлением банка.
const crypto = require('crypto');
const QRCode = require('qrcode');
const { html, raw } = require('./html');
const { rub } = require('./util');
const { icon } = require('./icons');
const { PAY_METHODS } = require('./delivery');

class PayError extends Error {}

const SBP_HOST = 'qr.nspk.ru';
const UNPAID = ['new', 'confirmed'];

// Подпись запросов и уведомлений ТБанка: значения корневых полей (без Token, вложенных Receipt и DATA) + Password,
// отсортированные по имени поля, склеенные подряд, SHA-256.
function tbankToken(params, password) {
  const flat = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'Token' || v === null || v === undefined || typeof v === 'object') continue;
    flat[k] = String(v);
  }
  flat.Password = password;
  return crypto.createHash('sha256').update(Object.keys(flat).sort().map((k) => flat[k]).join('')).digest('hex');
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Проверка того, что владелец вписал в настройках оплаты. Возвращает { error } или { value }.
function validatePayment(b) {
  const sbpEnabled = b.sbpEnabled === 'on';
  const transferEnabled = b.transferEnabled === 'on';
  const sbpUrl = clean(b.sbpUrl, 300);
  const r = { name: clean(b.name, 200), inn: clean(b.inn, 12), account: clean(b.account, 20), bank: clean(b.bank, 120), bik: clean(b.bik, 9), corr: clean(b.corr, 20) };
  if (sbpEnabled || sbpUrl) {
    let u;
    try { u = new URL(sbpUrl); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.hostname !== SBP_HOST || u.pathname.length < 10) {
      return { error: `Ссылка СБП должна быть вида https://${SBP_HOST}/... (её даёт банк в разделе «QR-код для приёма платежей»)` };
    }
  }
  const any = Object.values(r).some(Boolean);
  if (transferEnabled || any) {
    if (!r.name) return { error: 'Укажите получателя платежа' };
    if (!/^(\d{10}|\d{12})$/.test(r.inn)) return { error: 'ИНН: 10 цифр для компании или 12 для ИП' };
    if (!/^\d{20}$/.test(r.account)) return { error: 'Расчётный счёт: 20 цифр' };
    if (!r.bank) return { error: 'Укажите банк получателя' };
    if (!/^\d{9}$/.test(r.bik)) return { error: 'БИК: 9 цифр' };
    if (!/^\d{20}$/.test(r.corr)) return { error: 'Корреспондентский счёт: 20 цифр' };
  }
  return { value: { sbpEnabled, sbpUrl, transferEnabled, requisites: r } };
}

const requisitesComplete = (r) => Boolean(r && r.name && /^(\d{10}|\d{12})$/.test(r.inn) && /^\d{20}$/.test(r.account) && r.bank && /^\d{9}$/.test(r.bik) && /^\d{20}$/.test(r.corr));

function createPayments({ db, cfg, settings, notifier, fetchImpl = fetch }) {
  const a = cfg.acquiring || {};
  const cardOn = Boolean(a.terminalKey && a.password && cfg.publicUrl);
  const qrCache = new Map();

  async function qrSvg(url) {
    if (!qrCache.has(url)) {
      qrCache.set(url, await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#171412', light: '#ffffff' } }));
      if (qrCache.size > 20) qrCache.delete(qrCache.keys().next().value);
    }
    return qrCache.get(url);
  }

  // Способы оплаты, доступные покупателю на оформлении: в порядке показа
  async function methods() {
    const p = (await settings.get()).payment;
    const out = [];
    if (p.sbpEnabled && p.sbpUrl) out.push('sbp');
    if (cardOn) out.push('card');
    if (p.transferEnabled && requisitesComplete(p.requisites)) out.push('transfer');
    out.push('cod');
    return out;
  }

  const copyBtn = (value, label) => html`<button class="copy" type="button" data-copy="${value}" aria-label="Скопировать: ${label}">${icon('copy')}</button>`;

  async function sbpBlock(o, p) {
    const svg = await qrSvg(p.sbpUrl);
    return html`<section class="paybox paybox--sbp">
      <header class="paybox__h"><span class="paybox__ic">${icon('qr')}</span><div><h2>Оплата по СБП</h2><p class="muted">К оплате <b>${rub(Number(o.total))}</b></p></div></header>
      <div class="paybox__sbp">
        <div class="paybox__qr" role="img" aria-label="QR-код для оплаты по СБП">${raw(svg)}</div>
        <div class="paybox__how">
          <ol class="paybox__steps">
            <li>На телефоне нажмите кнопку «Открыть в приложении банка», с компьютера наведите камеру телефона на QR-код</li>
            <li>Выберите свой банк и проверьте получателя</li>
            <li>Если сумма не подставилась, введите <b>${rub(Number(o.total))}</b>, а в сообщении получателю укажите <b>Заказ №${o.number}</b></li>
          </ol>
          <a class="btn btn--lg" href="${p.sbpUrl}" target="_blank" rel="noopener noreferrer">Открыть в приложении банка ${icon('arrow-up-right')}</a>
        </div>
      </div>
      <p class="paybox__note">Платёж поступит на счёт ${p.requisites && p.requisites.name ? p.requisites.name : 'магазина'}. Менеджер подтвердит оплату и сразу начнёт собирать заказ.</p>
    </section>`;
  }

  function transferBlock(o, p) {
    const r = p.requisites;
    const purpose = `Оплата заказа №${o.number}`;
    const rows = [['Получатель', r.name], ['ИНН', r.inn], ['Расчётный счёт', r.account], ['Банк получателя', r.bank], ['БИК', r.bik], ['Корр. счёт', r.corr], ['Назначение платежа', purpose], ['Сумма', String(Number(o.total))]];
    return html`<section class="paybox paybox--transfer">
      <header class="paybox__h"><span class="paybox__ic">${icon('bank')}</span><div><h2>Перевод по реквизитам</h2><p class="muted">К оплате <b>${rub(Number(o.total))}</b></p></div></header>
      <dl class="reqs">${rows.map(([k, v]) => html`<div class="reqs__row"><dt>${k}</dt><dd>${k === 'Сумма' ? rub(Number(o.total)) : v}</dd>${copyBtn(v, k)}</div>`)}</dl>
      <p class="paybox__note">В назначении платежа обязательно укажите <b>${purpose}</b>: так мы найдём ваш платёж. После поступления менеджер подтвердит заказ.</p>
    </section>`;
  }

  function cardBlock(o) {
    return html`<section class="paybox paybox--card">
      <header class="paybox__h"><span class="paybox__ic">${icon('card')}</span><div><h2>Оплата картой</h2><p class="muted">К оплате <b>${rub(Number(o.total))}</b></p></div></header>
      <p>Вы перейдёте на защищённую страницу банка. Данные карты вводятся только там, магазин их не видит.</p>
      <a class="btn btn--lg" href="/order/${o.number}/pay/card?t=${encodeURIComponent(o.token)}" rel="nofollow">Оплатить картой ${icon('arrow-right')}</a>
    </section>`;
  }

  // Блок оплаты на странице заказа. query: { paid, payerr } из адреса возврата и ошибок.
  async function block(o, query = {}) {
    const p = (await settings.get()).payment;
    if (o.status === 'paid') return html`<div class="alert alert--ok">${icon('check')} Оплата получена, спасибо! Заказ передан в сборку.</div>`;
    if (!UNPAID.includes(o.status) || o.pay_method === 'cod') return '';
    const parts = [];
    if (query.paid === '0') parts.push(html`<div class="alert alert--err">Оплата не прошла. Попробуйте ещё раз или выберите другой способ.</div>`);
    if (query.paid === '1') parts.push(html`<div class="alert alert--ok">Спасибо! Банк обрабатывает платёж, статус заказа обновится в течение минуты.</div>`);
    if (query.payerr) parts.push(html`<div class="alert alert--err">Не удалось открыть страницу оплаты картой. Попробуйте ещё раз или оплатите по СБП или реквизитам.</div>`);
    const sbpOk = p.sbpEnabled && p.sbpUrl;
    const transferOk = p.transferEnabled && requisitesComplete(p.requisites);
    if (o.pay_method === 'sbp' && sbpOk) parts.push(await sbpBlock(o, p));
    else if (o.pay_method === 'transfer' && transferOk) parts.push(transferBlock(o, p));
    else if (o.pay_method === 'card' && cardOn) parts.push(cardBlock(o));
    else if (o.pay_method === 'online') parts.push(html`<div class="alert">Менеджер пришлёт ссылку на оплату после подтверждения заказа.</div>`);
    else { // выбранный способ сейчас недоступен: предлагаем то, что работает
      if (sbpOk) parts.push(await sbpBlock(o, p));
      if (transferOk) parts.push(transferBlock(o, p));
    }
    return html`<div class="payboxes">${parts}</div>`;
  }

  // ---------- Карта онлайн: ТБанк ----------
  const kop = (rubles) => Math.round(Number(rubles) * 100);

  function receiptOf(o) {
    if (!a.taxation) return null;
    const tax = a.tax || 'none';
    const items = o.items.map((i) => ({ Name: clean(`${i.title}${i.size ? ', ' + i.size : ''}`, 128), Price: kop(i.price), Quantity: i.qty, Amount: kop(i.price) * i.qty, Tax: tax, PaymentMethod: 'full_payment', PaymentObject: 'commodity' }));
    if (Number(o.delivery_cost) > 0) items.push({ Name: 'Доставка', Price: kop(o.delivery_cost), Quantity: 1, Amount: kop(o.delivery_cost), Tax: tax, PaymentMethod: 'full_payment', PaymentObject: 'service' });
    const contact = o.email ? { Email: o.email } : { Phone: `+${String(o.phone).replace(/\D/g, '')}` };
    return { ...contact, Taxation: a.taxation, Items: items };
  }

  async function startCard(o) {
    if (!cardOn) throw new PayError('Оплата картой не подключена');
    const prev = (await db.query('SELECT COUNT(*)::int AS n FROM webshop.payments WHERE order_id = $1', [o.id])).rows[0].n;
    const providerOrderId = prev ? `${o.number}-${prev + 1}` : String(o.number);
    const back = `${cfg.publicUrl}/order/${o.number}?t=${encodeURIComponent(o.token)}`;
    const body = {
      TerminalKey: a.terminalKey, Amount: kop(o.total), OrderId: providerOrderId, Description: `Заказ №${o.number}`, Language: 'ru',
      SuccessURL: `${back}&paid=1`, FailURL: `${back}&paid=0`, NotificationURL: `${cfg.publicUrl}/pay/tbank/notify`,
    };
    body.Token = tbankToken(body, a.password);
    const data = { Phone: `+${String(o.phone).replace(/\D/g, '')}`, ...(o.email ? { Email: o.email } : {}) };
    const receipt = receiptOf(o);
    let res;
    let json = null;
    try {
      res = await fetchImpl(`${a.apiUrl}/Init`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ ...body, DATA: data, ...(receipt ? { Receipt: receipt } : {}) }),
      });
      try { json = await res.json(); } catch { /* не JSON */ }
    } catch (e) {
      throw new PayError(`Банк недоступен: ${e.message}`);
    }
    if (!res.ok || !json || !json.Success || !json.PaymentURL) {
      throw new PayError(`Банк не создал платёж: ${(json && (json.Message || json.Details)) || 'HTTP ' + res.status}${json && json.ErrorCode ? ' (код ' + json.ErrorCode + ')' : ''}`);
    }
    await db.query(
      `INSERT INTO webshop.payments (order_id, provider, provider_order_id, provider_payment_id, amount, status, url)
       VALUES ($1, 'tbank', $2, $3, $4, $5, $6)`, [o.id, providerOrderId, String(json.PaymentId || ''), Number(o.total), String(json.Status || 'NEW'), String(json.PaymentURL)]);
    return String(json.PaymentURL);
  }

  // Уведомление банка о статусе платежа. Возвращает 'ok' или 'bad' (подпись не сошлась).
  async function handleNotify(body) {
    if (!cardOn || !body || typeof body !== 'object' || !body.Token || body.TerminalKey !== a.terminalKey) return 'bad';
    const expected = tbankToken(body, a.password);
    const given = String(body.Token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return 'bad';
    const pid = String(body.PaymentId || '');
    const status = String(body.Status || '');
    await db.tx(async (c) => {
      const { rows } = await c.query("SELECT * FROM webshop.payments WHERE provider = 'tbank' AND provider_payment_id = $1 FOR UPDATE", [pid]);
      const pay = rows[0];
      if (!pay) return; // чужой платёж или запись потеряна: ничего не меняем, но банку отвечаем OK
      await c.query('UPDATE webshop.payments SET status = $2, updated_at = NOW() WHERE id = $1', [pay.id, status]);
      if (status !== 'CONFIRMED') return;
      if (kop(pay.amount) !== Number(body.Amount)) {
        await c.query("INSERT INTO webshop.order_events (order_id, kind, text) VALUES ($1, 'note', $2)", [pay.order_id, `Платёж ТБанка №${pid}: сумма ${Number(body.Amount) / 100} ₽ не совпала с суммой заказа, заказ не отмечен оплаченным`]);
        return;
      }
      const upd = await c.query("UPDATE webshop.orders SET status = 'paid', updated_at = NOW() WHERE id = $1 AND status IN ('new', 'confirmed') RETURNING id", [pay.order_id]);
      if (upd.rowCount) {
        await c.query("INSERT INTO webshop.order_events (order_id, kind, text) VALUES ($1, 'status', $2)", [pay.order_id, `Оплачено картой (ТБанк, платёж №${pid})`]);
        if (notifier) await notifier.enqueue(c, pay.order_id, 'order_paid');
      }
    });
    if (notifier) notifier.kick();
    return 'ok';
  }

  return { methods, block, startCard, handleNotify, cardEnabled: () => cardOn, validatePayment, requisitesComplete, PayError };
}

module.exports = { createPayments, PayError, tbankToken, validatePayment, requisitesComplete, UNPAID };
