'use strict';
// Страницы личного кабинета: вход, кабинет, политика. Оформление в стиле витрины (public/css/account.css).
const { html } = require('./html');
const { icon } = require('./icons');
const { formatPhone } = require('./util');

const maskPhone = (p) => (String(p).length === 11 ? `+7 (${p.slice(1, 4)}) •••-••-${p.slice(9)}` : String(p));
const TAB_TITLES = { tg: 'Telegram', sms: 'SMS', pw: 'Почта и пароль' };

const consentCheck = () => html`<label class="check check--consent"><input type="checkbox" name="consent" value="on" required>
  <span>Согласен на <a href="/privacy" target="_blank">обработку персональных данных</a></span></label>`;

function smsPane({ step, phone, next }) {
  if (step === 'code') {
    return html`<form class="authform" method="post" action="/login/sms/verify">
      <input type="hidden" name="phone" value="${phone}"><input type="hidden" name="next" value="${next}">
      <p>Мы отправили SMS с кодом на <b>${maskPhone(phone)}</b>.</p>
      <label class="field">Код из SMS<input class="codeinput" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
      <button class="btn btn--lg btn--block" type="submit">Войти ${icon('arrow-right')}</button>
      <p class="authnote"><a class="link" href="/login?tab=sms${next ? `&next=${encodeURIComponent(next)}` : ''}">Изменить номер</a></p>
    </form>`;
  }
  return html`<form class="authform" method="post" action="/login/sms/send">
    <input type="hidden" name="next" value="${next}">
    <label class="field">Телефон<input name="phone" value="${phone ? formatPhone(phone) : ''}" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 900 123-45-67" data-phone></label>
    ${consentCheck()}
    <button class="btn btn--lg btn--block" type="submit">Получить код по SMS ${icon('arrow-right')}</button>
    <p class="authnote muted">Пришлём SMS с шестизначным кодом. Нет аккаунта: он создастся при первом входе.</p>
  </form>`;
}

// panes - готовые блоки вкладок { sms, tg, pw }; tabs - ключи доступных вкладок
function loginView({ tabs, tab, next = '', error = '', panes }) {
  const q = (k) => `/login?tab=${k}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  return html`<section class="wrap authpage">
    <div class="authbox">
      <p class="eyebrow">${icon('user')} Личный кабинет</p>
      <h1>Вход и регистрация</h1>
      <p class="muted">Скидки, история заказов и статусы доставки в одном месте. Аккаунт создаётся при первом входе.</p>
      ${tabs.length > 1 ? html`<nav class="authtabs" aria-label="Способ входа">${tabs.map((k) => html`<a class="${k === tab ? 'is-active' : ''}" href="${q(k)}" ${k === tab ? html`aria-current="page"` : ''}>${TAB_TITLES[k]}</a>`)}</nav>` : ''}
      ${error ? html`<div class="alert alert--err" role="alert">${error}</div>` : ''}
      ${panes[tab] || ''}
    </div>
  </section>`;
}

function accountHome({ customer }) {
  return html`<section class="wrap cabinet">
    <p class="eyebrow">${icon('user')} Личный кабинет</p>
    <h1>Здравствуйте, ${customer.name || formatPhone(customer.phone)}</h1>
    <form method="post" action="/account/logout"><button class="btn btn--ghost" type="submit">Выйти</button></form>
  </section>`;
}

function privacyPage({ shopName, email, operator }) {
  return html`<section class="wrap legal">
    <h1>Политика обработки персональных данных</h1>
    <!-- Черновик текста: перед запуском магазина покажите его юристу. -->
    <p>Оператор персональных данных: ${operator || shopName}. Связаться по вопросам обработки данных можно по адресу ${email}.</p>
    <h2>Какие данные мы обрабатываем</h2>
    <p>Имя, номер телефона, адрес электронной почты, адрес доставки, состав и история заказов, идентификатор в Telegram (если вы привязали его к аккаунту), сведения о посещениях сайта.</p>
    <h2>Зачем</h2>
    <p>Чтобы принять и доставить заказ, подтвердить вашу личность при входе в личный кабинет, начислять скидки по программе лояльности и сообщать о статусе заказа.</p>
    <h2>Кому передаём</h2>
    <p>Только тем, кто нужен для выполнения заказа: службам доставки, платёжным сервисам и банкам, сервисам отправки SMS и писем, Telegram. Данные не продаются.</p>
    <h2>Сколько храним</h2>
    <p>Пока у вас есть аккаунт и в течение срока, который требуют правила учёта и закон. Удалить аккаунт и данные можно, написав нам.</p>
    <h2>Ваши права</h2>
    <p>Вы можете запросить сведения о своих данных, исправить их, отозвать согласие и потребовать удаления, написав на ${email}.</p>
  </section>`;
}

module.exports = { loginView, smsPane, accountHome, privacyPage, maskPhone, consentCheck, TAB_TITLES };
