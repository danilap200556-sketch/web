'use strict';
// Страницы личного кабинета: вход, кабинет, политика. Оформление в стиле витрины (public/css/account.css).
const { html } = require('./html');
const { icon } = require('./icons');
const { formatPhone, rub } = require('./util');
const { STATUSES } = require('./orders');

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
function tgPane({ step, url = '', token = '', next = '', action = '/login/telegram/verify' }) {
  if (step === 'wait') {
    return html`<form class="authform" method="post" action="${action}" data-tg-token="${token}">
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

// Карта лояльности: уровень, скидка, шкала до следующего уровня (status - результат loyalty.statusOf)
function loyaltyCard({ status, shopName }) {
  const { tier, next, toNext, spent, pct, personal } = status;
  const goal = next ? next.from : 0;
  return html`<section class="lcard" aria-label="Карта лояльности">
    <div class="lcard__top"><span class="lcard__brand">${shopName}</span><span class="lcard__no">${status.cardNo}</span></div>
    <p class="lcard__tier">${tier.name}</p>
    <p class="lcard__pct">Скидка ${pct}%</p>
    ${personal > 0 ? html`<p class="lcard__note">Личная скидка ${personal}%</p>` : ''}
    ${next
      ? html`<progress class="lcard__bar" max="${goal}" value="${Math.min(spent, goal)}" aria-label="Накоплено до следующего уровня">${Math.round((spent / goal) * 100)}%</progress>
        <p class="lcard__sub">Накоплено ${rub(spent)} · до уровня «${next.name}» осталось ${rub(toNext)}</p>`
      : html`<p class="lcard__sub">Накоплено ${rub(spent)} · вы на высшем уровне</p>`}
  </section>`;
}

function orderRows(orders, fmt) {
  if (!orders.length) return html`<p class="muted">Заказов пока нет. <a class="link" href="/catalog">Перейти в каталог</a></p>`;
  return html`<ul class="orderlist">${orders.map((o) => {
    const st = STATUSES[o.status] || { title: o.status, tone: 'gray' };
    return html`<li><a class="orderrow" href="/order/${o.number}?t=${o.token}">
      <span class="orderrow__n">Заказ № ${o.number}</span>
      <span class="orderrow__d muted">${fmt.dateTime(o.created_at)}</span>
      <span class="ostatus ostatus--${st.tone}">${st.title}</span>
      <b class="orderrow__sum">${rub(o.total)}</b></a></li>`;
  })}</ul>`;
}

function accountHome({ customer, status, orders, fmt, shopName, botOn }) {
  return html`<section class="wrap cabinet">
    <p class="eyebrow">${icon('user')} Личный кабинет</p>
    <h1>${customer.name ? `Здравствуйте, ${customer.name}` : 'Здравствуйте!'}</h1>
    <p class="muted cabinet__phone">${formatPhone(customer.phone)}</p>
    <div class="cabinet__grid">
      <div class="cabinet__side">
        ${status.enabled ? loyaltyCard({ status, shopName }) : ''}
        <nav class="cabinet__links" aria-label="Настройки аккаунта">
          <a class="link" href="/account/profile">Профиль</a>
          <a class="link" href="/account/password">${customer.password_hash ? 'Сменить пароль' : 'Задать пароль'}</a>
          ${botOn ? html`<a class="link" href="/account/telegram">${customer.telegram_id ? 'Telegram: уведомления' : 'Привязать Telegram'}</a>` : ''}
          <form method="post" action="/account/logout"><button class="link link--btn" type="submit">Выйти</button></form>
        </nav>
      </div>
      <div class="cabinet__main">
        <h2>Мои заказы</h2>
        ${orderRows(orders, fmt)}
      </div>
    </div>
  </section>`;
}

// Привязка Telegram и уведомления о заказах. step 'wait' - ссылка на бота и поле для кода.
function telegramView({ customer, step = 'idle', token = '', url = '', error = '', saved = false }) {
  let body;
  if (step === 'wait') {
    body = tgPane({ step: 'wait', token, url, action: '/account/telegram/verify' });
  } else if (customer.telegram_id) {
    body = html`<p>Telegram привязан. Бот сообщает о смене статуса ваших заказов.</p>
      <form class="authform" method="post" action="/account/telegram/notify"><input type="hidden" name="on" value="${customer.tg_notify ? '0' : '1'}">
        <button class="btn btn--lg btn--block btn--ghost" type="submit">${customer.tg_notify ? 'Выключить уведомления' : 'Включить уведомления'}</button></form>
      <form class="authform" method="post" action="/account/telegram/unlink"><button class="btn btn--lg btn--block btn--ghost" type="submit">Отвязать Telegram</button></form>`;
  } else {
    body = html`<p>Привяжите Telegram: бот будет сообщать о статусе заказов, а вход в кабинет станет быстрее. Нужен Telegram с тем же номером, что и в аккаунте.</p>
      <form class="authform" method="post" action="/account/telegram/link"><button class="btn btn--lg btn--block" type="submit">Привязать Telegram ${icon('arrow-right')}</button></form>`;
  }
  return boxPage({ title: 'Telegram', error, notice: saved ? 'Готово' : '', body: html`${body}<p class="authnote"><a class="link" href="/account">Назад в кабинет</a></p>` });
}

// Политика обработки персональных данных (заготовка по 152-ФЗ). Показывается на /privacy, пока магазин не опубликовал свою страницу
// «Политика конфиденциальности» в админке. Оператор, адрес и почта подставляются из настроек. Перед запуском текст покажите юристу.
function privacyPage({ shopName, email, operator, siteUrl = '', phone = '' }) {
  const op = operator || shopName;
  const site = siteUrl || 'сайт магазина';
  const sections = [
    ['1. Общие положения', [
      `1.1. Настоящая политика составлена в соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных» и определяет порядок обработки персональных данных и меры по их защите. Оператор персональных данных: ${op} (далее - Оператор).`,
      '1.2. Оператор исходит из того, что соблюдение прав и свобод человека и гражданина при обработке его персональных данных, в том числе права на неприкосновенность частной жизни, личную и семейную тайну, является важнейшим условием его деятельности.',
      `1.3. Политика применяется ко всей информации, которую Оператор получает о посетителях и покупателях интернет-магазина ${site} (далее - Сайт).`,
      '1.4. Используя Сайт, оформляя заказ или входя в личный кабинет, пользователь соглашается с этой политикой. Если вы не согласны с ней, пожалуйста, не пользуйтесь Сайтом.',
    ]],
    ['2. Основные понятия', [
      '2.1. Персональные данные - любая информация, относящаяся прямо или косвенно к определённому или определяемому пользователю Сайта.',
      '2.2. Обработка персональных данных - любое действие с ними: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, передача, обезличивание, блокирование, удаление, уничтожение.',
      '2.3. Пользователь - любой посетитель Сайта. Покупатель - пользователь, оформивший заказ. Личный кабинет - раздел Сайта, доступный после входа по коду из Telegram или SMS либо по почте и паролю.',
    ]],
    ['3. Какие данные мы обрабатываем', [
      '3.1. Данные, которые вы указываете сами: имя, номер телефона, адрес электронной почты, адрес и способ доставки, комментарий к заказу.',
      '3.2. Данные об использовании магазина: состав и история заказов, статусы заказов, сведения о начисленных и применённых скидках, уровень в программе лояльности.',
      '3.3. Идентификатор и номер телефона в Telegram - если вы входите через Telegram-бота или привязываете Telegram к личному кабинету.',
      '3.4. Технические данные: случайные идентификаторы посетителя и визита в cookie, посещённые страницы, источник перехода, тип устройства. Сторонние счётчики на Сайте не используются.',
      '3.5. Мы не просим и не обрабатываем специальные категории персональных данных (о здоровье, убеждениях и т. п.) и данные банковских карт: ввод карты происходит на защищённой странице банка.',
    ]],
    ['4. Цели и основания обработки', [
      '4.1. Цели: приём, подтверждение, оплата и доставка заказа; связь с вами по заказу; подтверждение вашей личности при входе в личный кабинет (коды в Telegram и SMS, восстановление пароля); ведение программы лояльности и расчёт скидки; уведомления о статусе заказа; ответы на обращения; улучшение работы Сайта; исполнение требований закона.',
      '4.2. Правовые основания: ваше согласие (его вы даёте, отмечая соответствующую галочку), договор розничной купли-продажи, заключаемый при оформлении заказа, и требования законодательства РФ.',
      '4.3. Сообщения о статусе заказа в Telegram приходят только тем, кто сам привязал Telegram в личном кабинете; отключить их можно командой /stop в боте или в кабинете.',
    ]],
    ['5. Как мы обрабатываем и защищаем данные', [
      '5.1. Обработка ведётся с использованием средств автоматизации: сбор, запись, систематизация, накопление, хранение, уточнение, использование, передача (в случаях из раздела 6), блокирование, удаление и уничтожение.',
      '5.2. Срок хранения: пока существует ваш аккаунт или пока это нужно для целей обработки, а данные о заказах - в течение сроков, которые требует законодательство об учёте и защите прав потребителей. После этого данные удаляются или обезличиваются.',
      '5.3. Меры защиты: пароли хранятся только в виде необратимого хэша; коды входа и ссылки восстановления хранятся в защищённом виде и действуют ограниченное время; число попыток ввода кода и пароля ограничено; доступ сотрудников к данным разграничен по ролям; обмен данными с Сайтом идёт по защищённому соединению.',
      '5.4. Оператор не продаёт персональные данные и не передаёт их третьим лицам для рекламы.',
    ]],
    ['6. Кому мы передаём данные', [
      '6.1. Только тем, без кого невозможно выполнить заказ или вход: службам доставки и курьерам (СДЭК, Boxberry, Почта России и др.) - имя, телефон, адрес; платёжным сервисам и банкам - для приёма оплаты; сервису отправки SMS и почтовому сервису - номер телефона или адрес почты и текст кода; Telegram - при входе через бота и отправке уведомлений.',
      '6.2. Если вы заказываете товар партнёра-поставщика, ему передаются данные, нужные для выполнения заказа.',
      '6.3. Telegram - иностранный сервис: при его использовании данные обрабатываются по правилам Telegram. Если вы не хотите этого, входите по SMS или по почте и паролю.',
      '6.4. По запросу уполномоченных государственных органов данные передаются в порядке, предусмотренном законом.',
    ]],
    ['7. Права пользователя', [
      '7.1. Вы вправе получить сведения об обработке своих данных, потребовать их уточнения, блокирования или уничтожения, если они неполные, устарели, неточны или не нужны для заявленной цели, а также отозвать согласие на обработку.',
      `7.2. Чтобы воспользоваться правами, напишите Оператору на ${email || 'почту магазина'}${phone ? ` или позвоните по телефону ${phone}` : ''}. Мы ответим в сроки, установленные законом (до 10 рабочих дней).`,
      '7.3. Вы вправе обратиться в Роскомнадзор (уполномоченный орган по защите прав субъектов персональных данных) или в суд, если считаете, что данные обрабатываются с нарушением закона.',
      '7.4. Отзыв согласия не отменяет обработки, необходимой для исполнения уже заключённого договора и для соблюдения требований закона.',
    ]],
    ['8. Cookie и аналитика', [
      '8.1. Сайт использует cookie: чтобы работали корзина и вход в личный кабинет и чтобы считалась статистика посещений (без сторонних счётчиков).',
      '8.2. Карта на Сайте - сервис Яндекса, у него свои cookie и правила.',
      '8.3. Вы можете отключить cookie в настройках браузера, но корзина и личный кабинет без них работать не будут.',
    ]],
    ['9. Заключительные положения', [
      `9.1. Оператор вправе изменять политику. Новая редакция действует с момента публикации на странице ${site}/privacy, если иное не указано в ней.`,
      `9.2. Вопросы по обработке данных: ${email || 'почта магазина'}.`,
    ]],
  ];
  return html`<section class="wrap legal">
    <h1>Политика в отношении обработки персональных данных</h1>
    <!-- Черновик текста: перед запуском магазина покажите его юристу. Свою политику можно опубликовать в админке: «Страницы» -> privacy. -->
    ${sections.map(([title, paras]) => html`<h2>${title}</h2>${paras.map((p) => html`<p>${p}</p>`)}`)}
  </section>`;
}

module.exports = { telegramView, loginView, smsPane, tgPane, pwPane, forgotView, resetView, messageView, welcomeView, profileView, passwordView, accountHome, privacyPage, maskPhone, consentCheck, TAB_TITLES };
