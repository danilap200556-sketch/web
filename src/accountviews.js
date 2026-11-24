'use strict';
// Страницы личного кабинета: вход, кабинет, политика. Оформление в стиле витрины (public/css/account.css).
const { html } = require('./html');
const { icon } = require('./icons');
const { formatPhone } = require('./util');

const maskPhone = (p) => (String(p).length === 11 ? `+7 (${p.slice(1, 4)}) •••-••-${p.slice(9)}` : String(p));
const TAB_TITLES = { tg: 'Telegram', sms: 'SMS', pw: 'Почта и пароль' };
const qs = (next) => (next ? `&next=${encodeURIComponent(next)}` : '');

// Общая «коробка» для небольших страниц кабинета: заголовок, пояснение, сообщения, содержимое
const boxPage = ({ title, intro = '', error = '', notice = '', body = '', eyebrow = 'Личный кабинет' }) => html`<section class="wrap authpage">
  <div class="authbox">
    <p class="eyebrow">${icon('user')} ${eyebrow}</p>
    <h1>${title}</h1>
    ${intro ? html`<p class="muted">${intro}</p>` : ''}
    ${notice ? html`<div class="alert alert--ok" role="status">${notice}</div>` : ''}
    ${error ? html`<div class="alert alert--err" role="alert">${error}</div>` : ''}
    ${body}
  </div>
</section>`;

function pwPane({ next, login = '' }) {
  return html`<form class="authform" method="post" action="/login/password">
    <input type="hidden" name="next" value="${next}">
    <label class="field">Телефон или почта<input name="login" value="${login}" autocomplete="username" required maxlength="120"></label>
    <label class="field">Пароль<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
    <button class="btn btn--lg btn--block" type="submit">Войти ${icon('arrow-right')}</button>
    <p class="authnote"><a class="link" href="/login/forgot${next ? `?next=${encodeURIComponent(next)}` : ''}">Забыли пароль?</a></p>
  </form>`;
}

function forgotView({ channels, error = '', sent = false }) {
  if (sent) return boxPage({ title: 'Проверьте почту', intro: 'Если такой аккаунт есть, мы отправили письмо со ссылкой для нового пароля. Ссылка действует час. Если письма нет, загляните в «Спам».', body: html`<a class="btn btn--ghost btn--block" href="/login">Назад ко входу</a>` });
  const to = `&next=${encodeURIComponent('/account/password')}`;
  return boxPage({
    title: 'Забыли пароль?', error,
    intro: 'Старый пароль восстановить нельзя, но можно подтвердить, что это вы, и задать новый. Выберите, куда прислать код или ссылку.',
    body: html`<div class="authform">
      ${channels.tg ? html`<a class="btn btn--lg btn--block" href="/login?tab=tg${to}">Код в Telegram ${icon('arrow-right')}</a>` : ''}
      ${channels.sms ? html`<a class="btn btn--lg btn--block" href="/login?tab=sms${to}">Код по SMS ${icon('arrow-right')}</a>` : ''}
      ${channels.mail ? html`<form class="authform" method="post" action="/login/forgot/mail">
        <label class="field">Телефон или почта аккаунта<input name="login" autocomplete="username" required maxlength="120"></label>
        <button class="btn btn--lg btn--block btn--ghost" type="submit">Прислать ссылку на почту</button>
        <p class="authnote muted">Ссылка придёт, только если почта в аккаунте подтверждена.</p>
      </form>` : ''}
    </div>`,
  });
}

const resetView = ({ token }) => boxPage({
  title: 'Новый пароль', intro: 'Ссылка из письма верна. Нажмите кнопку, чтобы войти и задать новый пароль.',
  body: html`<form class="authform" method="post" action="/login/reset"><input type="hidden" name="token" value="${token}">
    <button class="btn btn--lg btn--block" type="submit">Задать новый пароль ${icon('arrow-right')}</button></form>`,
});

const messageView = ({ title, text }) => boxPage({ title, intro: text, body: html`<a class="btn btn--ghost btn--block" href="/">На главную</a>` });

const passwordFields = (needOld) => html`${needOld ? html`<label class="field">Текущий пароль<input name="old" type="password" autocomplete="current-password" required maxlength="200"></label>` : ''}
  <label class="field">Новый пароль<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="200"></label>
  <label class="field">Повторите пароль<input name="password2" type="password" autocomplete="new-password" required minlength="8" maxlength="200"></label>`;

const welcomeView = ({ error = '', email = '' }) => boxPage({
  title: 'Добро пожаловать', error, eyebrow: 'Аккаунт создан',
  intro: 'Задайте почту и пароль, чтобы входить без кодов. Можно пропустить и сделать это позже в кабинете.',
  body: html`<form class="authform" method="post" action="/account/welcome">
    <label class="field">Электронная почта<input name="email" type="email" value="${email}" autocomplete="email" maxlength="120" placeholder="для входа и писем о заказах"></label>
    <label class="field">Пароль<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="200"></label>
    <label class="field">Повторите пароль<input name="password2" type="password" autocomplete="new-password" minlength="8" maxlength="200"></label>
    <button class="btn btn--lg btn--block" type="submit">Сохранить ${icon('arrow-right')}</button>
    <p class="authnote"><a class="link" href="/account">Пропустить</a></p>
  </form>`,
});

const profileView = ({ customer, error = '', saved = false, mailOn = false }) => boxPage({
  title: 'Профиль', error, notice: saved ? 'Сохранено' : '',
  body: html`<form class="authform" method="post" action="/account/profile">
    <label class="field">Имя<input name="name" value="${customer.name}" autocomplete="name" maxlength="80"></label>
    <label class="field">Электронная почта<input name="email" type="email" value="${customer.email}" autocomplete="email" maxlength="120"></label>
    ${customer.email ? html`<p class="authnote muted">${customer.email_verified_at ? 'Почта подтверждена' : (mailOn ? 'Почта не подтверждена: мы отправили письмо со ссылкой' : 'Почта не подтверждена')}</p>` : ''}
    <p class="authnote muted">Телефон: ${formatPhone(customer.phone)}</p>
    <button class="btn btn--lg btn--block" type="submit">Сохранить</button>
    <p class="authnote"><a class="link" href="/account">Назад в кабинет</a></p>
  </form>`,
});

const passwordView = ({ needOld, hasPassword, error = '', saved = false }) => boxPage({
  title: hasPassword ? 'Смена пароля' : 'Задать пароль', error, notice: saved ? 'Пароль сохранён. На других устройствах нужно войти заново.' : '',
  body: html`<form class="authform" method="post" action="/account/password">
    ${passwordFields(needOld)}
    <button class="btn btn--lg btn--block" type="submit">Сохранить пароль</button>
    <p class="authnote"><a class="link" href="/account">Назад в кабинет</a></p>
  </form>`,
});

// panes - готовые

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

// Вход через Telegram. step 'start' - кнопка, 'wait' - ссылка на бота и поле для кода (token нужен сайту, чтобы связать код с ссылкой)
function tgPane({ step, url = '', token = '', next }) {
  if (step === 'wait') {
    return html`<form class="authform" method="post" action="/login/telegram/verify" data-tg-token="${token}">
      <input type="hidden" name="token" value="${token}"><input type="hidden" name="next" value="${next}">
      <ol class="authsteps">
        <li>Откройте бота в Telegram по кнопке ниже</li>
        <li>Нажмите «Запустить» и «Поделиться номером»</li>
        <li>Бот пришлёт код: введите его здесь</li>
      </ol>
      <a class="btn btn--lg btn--block" href="${url}" target="_blank" rel="noopener noreferrer">Открыть бота в Telegram ${icon('arrow-up-right')}</a>
      <label class="field">Код из Telegram<input class="codeinput" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
      <button class="btn btn--lg btn--block btn--ghost" type="submit">Войти ${icon('arrow-right')}</button>
    </form>`;
  }
  return html`<form class="authform" method="post" action="/login/telegram/start">
    <input type="hidden" name="next" value="${next}">
    ${consentCheck()}
    <button class="btn btn--lg btn--block" type="submit">Войти через Telegram ${icon('arrow-right')}</button>
    <p class="authnote muted">Без паролей и SMS: бот подтвердит ваш номер и пришлёт код. Нет аккаунта: он создастся при первом входе.</p>
  </form>`;
}

// panes - готовые блоки вкладок { sms, tg, pw }; tabs - ключи доступных вкладок
function loginView({ tabs, tab, next = '', error = '', panes }) {
  const q = (k) => `/login?tab=${k}${qs(next)}`;
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
    <p class="cabinet__links"><a class="link" href="/account/profile">Профиль</a> · <a class="link" href="/account/password">Пароль</a></p>
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

module.exports = { loginView, smsPane, tgPane, pwPane, forgotView, resetView, messageView, welcomeView, profileView, passwordView, accountHome, privacyPage, maskPhone, consentCheck, TAB_TITLES };
