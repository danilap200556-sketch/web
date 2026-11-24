# Личный кабинет покупателя и лояльность: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Покупатель регистрируется и входит по Telegram-коду, SMS-коду или email+паролю (с «Забыли пароль»), видит кабинет с картой лояльности и заказами и получает накопительную скидку при оформлении.

**Architecture:** Аккаунт = существующая запись `webshop.customers` (ключ: подтверждённый телефон). Новые модули с узкими обязанностями: сессии в базе, одноразовые коды, аккаунты, адаптеры SMS и почты, Telegram-бот (длинный опрос), расчёт лояльности. Страницы витрины монтируются как `routes/account.js`; скидка считается на сервере внутри `createOrder`.

**Tech Stack:** Node 22, Express 5, pg, node:test на реальной PostgreSQL; новая зависимость только `nodemailer`. Сообщения и тексты интерфейса на русском.

**Spec:** `docs/superpowers/specs/2026-11-23-customer-accounts-design.md`

## Global Constraints

- CSP без inline-кода и стилей: вся динамика только в файлах `public/js`, стили в `public/css`.
- Схема базы только дописывается: новые операторы в конец `SCHEMA` в `src/schema.js`, все с `IF NOT EXISTS`.
- Телефон везде через `normalizePhone` из `src/util.js` (формат `7XXXXXXXXXX`).
- Код входа: 6 цифр, действует 10 минут, 5 попыток; на адресат не чаще 1 в минуту, не более 5 в час и 10 в сутки; на IP не более 20 в час; общий потолок SMS за сутки `cfg.sms.dailyCap` (по умолчанию 300).
- Неудачные пароли: 5 попыток за 15 минут на пару «адресат + IP» и 5 на адресат отдельно.
- Сессия покупателя 30 дней (`CUSTOMER_SESSION_DAYS`), «свежая» сессия (по коду или ссылке) 15 минут; токен в cookie, в базе только sha256-хэш; cookie `__Host-cs` при защищённых cookie, иначе `cs`.
- Уровни по умолчанию: Старт 0 ₽ 0%, Серебро 30 000 ₽ 3%, Золото 100 000 ₽ 5%, Платина 250 000 ₽ 7%. Накопление: `SUM(subtotal − discount)` заказов клиента со статусом `delivered`. Скидка: большее из уровня и личной; не на акционные строки (`model.oldPrice > 0`), на электронику партнёра действует; округление вниз до рубля; только вошедшему.
- Страницы аккаунта: `Cache-Control: no-store`, `noindex`, закрыты в `robots.txt`.
- Одинаковый ответ на «Забыли пароль» для известного и неизвестного адресата; ничего не отправляется неизвестному.
- Каждый канал без настройки (бот, SMS, почта) скрыт, остальное работает. Гостевой заказ работает как раньше.

## Review Focus

- Телефон в любом написании (`8 916…`, `+7 (916) …`, `916…`) попадает в один и тот же аккаунт (Task 7).
- Использованный или просроченный код не проходит; пятая неверная попытка сжигает код (Task 3).
- «Забыли пароль» для неизвестного адресата: тот же ответ, ни SMS, ни письма (Task 9); после смены пароля старые сессии мертвы (Task 9).
- Бот: контакт не владельца (`contact.user_id ≠ from.id`), сообщение не из личного чата, покупатель заблокировал бота (403) не ломают бота и не зацикливают очередь (Tasks 6, 12).
- Скидка: ровно на пороге уровня, все строки акционные (скидки и строки нет), округление вниз, гость с номером VIP без скидки, получатель с другим телефоном остаётся в заказах аккаунта (Tasks 2, 11).

---

## Карта файлов

Создать: `src/loyalty.js`, `src/customer-sessions.js`, `src/auth-codes.js`, `src/accounts.js`, `src/sms.js`, `src/mail.js`, `src/tgbot.js`, `src/routes/account.js`, `src/accountviews.js`, `src/admin/loyalty.js`, `public/css/account.css`, `public/js/account.js` (если понадобится), тесты `test/loyalty.test.js`, `test/accounts-core.test.js`, `test/sms-mail.test.js`, `test/tgbot.test.js`, `test/login.test.js`, `test/loyalty-checkout.test.js`, `test/customer-notify.test.js`, `test/admin-loyalty.test.js`.
Изменить: `src/schema.js`, `src/config.js`, `src/settings.js`, `src/app.js`, `src/bootstrap.js`, `src/orders.js`, `src/routes/cart.js`, `src/shopviews.js`, `src/notify.js`, `src/payments.js`, `src/admin/{routes,layout,auth,customers,manage,orders}.js`, `public/js/shop.js`, `test/helpers.js`, `package.json`, `README.md`, `.env.example`.

---

### Task 1: Схема и настройки окружения

**Files:** Modify `src/schema.js` (в конец списка), `src/config.js`, `.env.example`; Test `test/accounts-core.test.js`.

**Interfaces — Produces:**
- Колонки `customers`: `password_hash TEXT`, `phone_verified_at`, `email_verified_at TIMESTAMPTZ`, `telegram_id BIGINT`, `tg_notify BOOLEAN NOT NULL DEFAULT TRUE`, `personal_discount NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (BETWEEN 0 AND 100)`, `last_login_at TIMESTAMPTZ`. Индексы: уникальный по `telegram_id WHERE NOT NULL`; уникальный по `lower(email) WHERE password_hash IS NOT NULL AND email <> ''`.
- Таблицы: `customer_sessions(id BIGINT identity, customer_id INT REFERENCES customers ON DELETE CASCADE, token_hash TEXT UNIQUE, created_at, last_seen_at, expires_at, fresh_until TIMESTAMPTZ NULL, ip TEXT, ua TEXT)`; `auth_codes(id BIGINT identity, purpose, channel, target, code_hash TEXT, attempts INT DEFAULT 0, created_at, expires_at, used_at NULL, ip TEXT DEFAULT '')` с индексами `(purpose, target, created_at)` и `(channel, created_at)`; `tg_login(token TEXT PK, purpose TEXT, customer_id INT NULL, phone TEXT NULL, telegram_id BIGINT NULL, created_at, expires_at, consumed_at NULL)`.
- `outbox.payload TEXT NOT NULL DEFAULT ''`; `orders.discount NUMERIC(12,2) NOT NULL DEFAULT 0`, `orders.discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0`, `orders.discount_note TEXT NOT NULL DEFAULT ''`.
- `cfg.customer.sessionDays`; `cfg.sms = { provider, apiKey, sender, apiUrl (SMS_API_URL, по умолчанию https://sms.ru), dailyCap }`; `cfg.smtp = { host, port (587), secure (SMTP_SECURE==='true'), user, pass, from }`; `cfg.notify.telegramBotUsername` (`TELEGRAM_BOT_USERNAME`, необязательно). `load()` бросает ошибку, если `prod` и `SMS_PROVIDER=console`; допустимые `SMS_PROVIDER`: пусто, `smsru`, `console`.

- [ ] **Step 1: Тест.** `startShop('acc_schema')`; повторный `await shop.db.migrate()` не падает; `information_schema.columns` содержит `customers.telegram_id`, `orders.discount`, `outbox.payload`; вставка `personal_discount = 101` даёт ошибку CHECK; два клиента с одинаковым `telegram_id` дают ошибку уникальности; в `config.load({... NODE_ENV:'production', SMS_PROVIDER:'console'})` бросается исключение.
- [ ] **Step 2:** `node --test --test-concurrency=1 test/accounts-core.test.js` — FAIL (колонок нет).
- [ ] **Step 3:** Добавить операторы схемы и поля конфига; описать переменные в `.env.example` (SMS_*, SMTP_*, TELEGRAM_BOT_USERNAME, CUSTOMER_SESSION_DAYS).
- [ ] **Step 4:** Тот же запуск — PASS; `npm test` — всё зелёное (128 тестов).
- [ ] **Step 5:** `git add -A && git commit -m "Аккаунты покупателей: схема и настройки окружения"`

### Task 2: Расчёт лояльности

**Files:** Create `src/loyalty.js`; Modify `src/settings.js` (ключ `loyalty: DEFAULT_LOYALTY` в `defaults`); Test `test/loyalty.test.js`.

**Interfaces — Produces:**
- `DEFAULT_LOYALTY = { enabled: true, applyToSale: false, applyToElectronics: true, tiers: [{ name, from, percent }…] }` со значениями из Global Constraints.
- `validateLoyalty(body) → { error } | { value }`: поля формы `enabled`, `applyToSale`, `applyToElectronics` (`'on'`), массивы `tierName[]`, `tierFrom[]`, `tierPercent[]`; первый порог 0, пороги строго растут, процент 0–100, имя 1–30 символов, уровней 2–8.
- `tierFor(loyalty, spent) → { tier, index, next, toNext }` (`next` и `toNext` null на высшем).
- `effectivePct(loyalty, spent, personal) → number` (0, если `!enabled`).
- `computeDiscount(lines, pct, loyalty) → { discount, base }`; строка `{ pid, sum, model: { oldPrice } }`; электроника распознаётся через `isExtPid` из `src/ext.js`.
- `cardNumber(id) → 'SH-000042'`.
- `createLoyalty({ db, settings }) → { spentOf(customerId) → Promise<number>, statusOf(customerRow) → Promise<{ cardNo, spent, tier, next, toNext, personal, pct, enabled }> }`.

- [ ] **Step 1: Тесты (чистые, без базы, кроме `spentOf`).**
```js
assert.equal(tierFor(L, 29999).tier.name, 'Старт');
assert.equal(tierFor(L, 30000).tier.name, 'Серебро');          // ровно порог
assert.equal(tierFor(L, 250000).next, null);
assert.equal(effectivePct(L, 30000, 5), 5);                    // личная больше уровня
assert.equal(effectivePct({ ...L, enabled: false }, 1e6, 10), 0);
assert.deepEqual(computeDiscount([{ pid: 1, sum: 1999, model: { oldPrice: 0 } }], 3, L), { discount: 59, base: 1999 }); // вниз
assert.equal(computeDiscount([{ pid: 1, sum: 5000, model: { oldPrice: 6000 } }], 7, L).discount, 0);              // акционная
assert.equal(computeDiscount([{ pid: EXT_BASE + 1, sum: 10000, model: { oldPrice: 0 } }], 5, L).discount, 500);   // электроника да
assert.equal(computeDiscount([{ pid: EXT_BASE + 1, sum: 10000, model: { oldPrice: 0 } }], 5, { ...L, applyToElectronics: false }).discount, 0);
assert.equal(cardNumber(42), 'SH-000042');
assert.ok(validateLoyalty({ tierName: ['A', 'B', 'C'], tierFrom: ['0', '30000', '20000'], tierPercent: ['0', '3', '5'] }).error); // пороги не растут
```
И через `startShop`: `spentOf` считает только `delivered` и вычитает `discount` (две вставки заказов напрямую в базу: delivered и paid).
- [ ] **Step 2:** `node --test test/loyalty.test.js` — FAIL (модуля нет).
- [ ] **Step 3:** Реализовать `src/loyalty.js` и добавить настройку по умолчанию.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit «Лояльность: уровни, расчёт скидки, настройки по умолчанию».

### Task 3: Сессии, коды, аккаунты

**Files:** Create `src/customer-sessions.js`, `src/auth-codes.js`, `src/accounts.js`; Modify `test/helpers.js`; Test `test/accounts-core.test.js`.

**Interfaces — Produces:**
- `createSessions({ db, cfg }) → { cookieName, create(customerId, { ip, ua, fresh }) → Promise<token>, resolve(token) → Promise<{ customer, sessionId, fresh } | null>, destroy(token), destroyAll(customerId, exceptToken = null) }`. `resolve` обновляет `last_seen_at` не чаще раза в 10 минут; просроченную сессию не возвращает.
- `createCodes({ db, cfg }) → { issue({ purpose, channel, target, ip }) → Promise<{ code }>, verify({ purpose, target, code }) → Promise<boolean>, issueToken({ purpose, target, hours = 1 }) → Promise<{ token }>, consumeToken({ purpose, token }) → Promise<string|null> }`; `class CodeError { reason: 'rate' | 'cap' }`. Хэш кода — HMAC от `cfg.secret` по строке `purpose:target:code`; сравнение через `safeEqual` из `src/security.js`; `verify` смотрит последнюю неиспользованную непросроченную запись, увеличивает `attempts`, при пятой неудаче погашает её.
- `createAccounts({ db }) → { byId, byPhone, byLogin(login) (телефон по `normalizePhone`, иначе почта среди аккаунтов с паролем), ensureByVerifiedPhone(phone, { name }) → { customer, created }, setPassword(id, pw) (через `validateNewPassword`), checkPassword(customer, pw) → boolean, setProfile(id, { name, email }), markEmailVerified(id), bindTelegram(id, telegramId), touchLogin(id) }`; `class AccountError { code: 'weak-password' | 'email-taken' | 'tg-taken' | 'bad-email' }`. Смена почты сбрасывает `email_verified_at`.
- `test/helpers.js`: `loginAs(shop, c, phone, { name = 'Тест', fresh = false }) → customer` (создаёт подтверждённого клиента, сессию, кладёт cookie в `c.jar`).

- [ ] **Step 1: Тесты.**
```js
const t = await sessions.create(cust.id, { ip: '1.1.1.1', ua: 'x' });
assert.equal((await sessions.resolve(t)).customer.id, cust.id);
await sessions.destroyAll(cust.id); assert.equal(await sessions.resolve(t), null);
// код
const { code } = await codes.issue({ purpose: 'login-sms', channel: 'sms', target: '79160000001', ip: '1.1.1.1' });
assert.equal(await codes.verify({ purpose: 'login-sms', target: '79160000001', code: '000000' }), false);
assert.equal(await codes.verify({ purpose: 'login-sms', target: '79160000001', code }), true);
assert.equal(await codes.verify({ purpose: 'login-sms', target: '79160000001', code }), false);   // повторно нельзя
// пять неверных сжигают код: шестая попытка с верным кодом тоже false
// просрочка: UPDATE auth_codes SET expires_at = NOW() - INTERVAL '1 s' -> verify false
// лимиты: вторая выдача в течение минуты -> CodeError reason 'rate'; потолок cfg.sms.dailyCap=2 -> третья SMS reason 'cap'
// аккаунты
const a = await accounts.ensureByVerifiedPhone('79160000001', { name: 'Аня' }); assert.equal(a.created, true);
assert.equal((await accounts.ensureByVerifiedPhone('79160000001', {})).created, false);
await assert.rejects(accounts.setPassword(id, '123'), { code: 'weak-password' });
await accounts.setProfile(a1.id, { email: 'A@x.ru' }); await accounts.setPassword(a1.id, 'password-1');
await accounts.setProfile(a2.id, { email: 'a@x.ru' }); await accounts.setPassword(a2.id, 'password-2'); // -> email-taken
assert.equal((await accounts.byLogin('8 (916) 000-00-01')).id, a.customer.id);
```
- [ ] **Step 2:** `node --test --test-concurrency=1 test/accounts-core.test.js` — FAIL.
- [ ] **Step 3:** Реализовать три модуля и `loginAs`. Лимиты считать запросами по `auth_codes` (переживают перезапуск).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit «Аккаунты: сессии, одноразовые коды, управление клиентами».

### Task 4: Адаптер SMS

**Files:** Create `src/sms.js`; Modify `test/helpers.js` (`fakeSmsRu()`); Test `test/sms-mail.test.js`.

**Interfaces — Produces:** `createSms(smsCfg, { fetchImpl = fetch, log = console }) → { enabled(), send(phone, text) → Promise<void> }`; `class SmsError`. Провайдер `smsru`: `GET {apiUrl}/sms/send?api_id=…&to=<phone>&msg=<text>&json=1[&from=…]`, успех при `status === 'OK'` и `sms[phone].status === 'OK'`, таймаут 8 с. `console`: пишет `[sms] phone: text` в журнал. `fakeSmsRu() → { url, calls, mode: { fail }, close() }` для тестов.

- [ ] **Step 1: Тесты.** Отправка попадает на фейк с верными `api_id`, `to`, `msg`; `{status:'ERROR'}` и HTTP 500 дают `SmsError`; без ключа `enabled() === false` и `send` бросает; ключ не попадает в сообщение ошибки.
- [ ] **Step 2:** запуск файла — FAIL.
- [ ] **Step 3:** Реализовать. API SMS.ru взято из памяти: сверить с документацией, живую проверку отметить «не проверено вживую».
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit «SMS: адаптер SMS.ru и режим console».

### Task 5: Адаптер почты

**Files:** Create `src/mail.js`; Modify `package.json`/`package-lock.json` (`npm install nodemailer`); Test `test/sms-mail.test.js`.

**Interfaces — Produces:** `createMail(smtpCfg, { transport } = {}) → { enabled(), send({ to, subject, text }) → Promise<void> }`; `enabled()` требует `host`, `user`, `pass`, `from`; транспорт по умолчанию `nodemailer.createTransport` из конфига; для тестов передаётся `jsonTransport`.

- [ ] **Step 1: Тест.** С `jsonTransport: true` письмо содержит `to`, `subject`, `text`, `from` из конфига; без настроек `enabled() === false`.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit «Почта: адаптер SMTP на nodemailer».

### Task 6: Telegram-бот

**Files:** Create `src/tgbot.js`; Test `test/tgbot.test.js` (поддельный Telegram как `fakeTelegram` из `test/notify.test.js`, вынести его в `test/helpers.js` и расширить: ответ на `getUpdates` из очереди, `getMe`).

**Interfaces — Consumes:** `accounts`, `codes` (Task 3), `normalizePhone`. **Produces:**
`createBot({ db, cfg, accounts, codes, fetchImpl }) → { enabled(), username() → Promise<string>, createLink({ purpose: 'login' | 'link', customerId = null }) → Promise<{ token, url }>, handleUpdate(update), pollOnce(timeoutSec = 25), start(), stop(), sendToCustomer(telegramId, text) → Promise<{ ok, blocked }> }`.
Поведение `handleUpdate` (только личные чаты):
- `/start L<token>` или `/start K<token>`: токен из `tg_login`, не просрочен и не использован. Если `telegram_id` отправителя уже привязан к клиенту (для `L`) — записать в `tg_login` телефон клиента и сразу выдать код. Иначе ответить просьбой нажать кнопку «Поделиться номером» (reply-клавиатура с `request_contact`).
- Сообщение с `contact`: принимается только при `contact.user_id === from.id`; номер через `normalizePhone` (не РФ: ответ «пока только российские номера»); для `K` номер обязан совпасть с номером аккаунта `customer_id`; записать `phone`, `telegram_id` в `tg_login`, выдать код `codes.issue({ purpose: 'tg', channel: 'tg', target: token })` и отправить его сообщением «Код для входа: 123456. Никому не сообщайте».
- `/stop` выключает, `/notify` включает `customers.tg_notify` для привязанного клиента; `/start` без параметра — короткая справка.
- `pollOnce` продвигает `offset`; при HTTP 409 ждёт 30 с; одиночный опрос в процессе гарантирует сам Telegram (второй `getUpdates` получает 409).
- `sendToCustomer` при HTTP 403 возвращает `{ ok: false, blocked: true }`.
- `createLink` использует `cfg.notify.telegramBotUsername` или `getMe`; токен 18 случайных байт base64url, срок 15 минут; `url = https://t.me/<username>?start=L<token>`.

- [ ] **Step 1: Тесты.**
```js
const { token, url } = await bot.createLink({ purpose: 'login' });
assert.match(url, /^https:\/\/t\.me\/\w+\?start=L/);
await bot.handleUpdate(startUpdate(token, { from: 555 }));          // просит контакт
assert.ok(tg.calls.at(-1).body.reply_markup.keyboard[0][0].request_contact);
await bot.handleUpdate(contactUpdate({ from: 555, contactUser: 777, phone: '+79160000001' }));  // чужой контакт
assert.equal((await row(token)).phone, null);                       // отклонён
await bot.handleUpdate(contactUpdate({ from: 555, contactUser: 555, phone: '+7 916 000-00-01' }));
const code = /Код для входа: (\d{6})/.exec(tg.calls.at(-1).body.text)[1];
assert.equal(await codes.verify({ purpose: 'tg', target: token, code }), true);
// групповой чат: chat.type 'group' игнорируется; просроченный токен не принимается
// уже привязанный telegram_id: /start L<token2> сразу выдаёт код без запроса контакта
// /stop выключает tg_notify; sendToCustomer при 403 -> { ok:false, blocked:true }
// pollOnce: фейк отдаёт один update, бот его обработал и следующий вызов идёт с offset = update_id + 1
```
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit «Telegram-бот: вход по коду, привязка, команды».

### Task 7: Витрина, сессия, SMS-вход, выход

**Files:** Create `src/routes/account.js`, `src/accountviews.js`, `public/css/account.css`; Modify `src/app.js` (создать и положить в `services`: `sessions, codes, accounts, sms, mail, bot, loyalty`; смонтировать маршруты; `shutdown` останавливает бота), `src/bootstrap.js` (`bot.start()`), `src/shopviews.js` (ссылка в шапке и в боковом меню, `account.css`), `robots.txt` в `app.js`; Test `test/login.test.js`.

**Interfaces — Produces:**
- `shopCtx` кладёт `req.customer` и `req.ctx.customer = { id, name, phone, status (результат loyalty.statusOf) } | null` по cookie сессии.
- Страницы: `GET /login?next=` (вкладки «Telegram», «SMS», «Почта и пароль», видимы только настроенные; `next` пропускает только пути, начинающиеся с `/` и не с `//`), `POST /login/sms/send {phone, consent}`, `POST /login/sms/verify {phone, code}`, `POST /account/logout`, `GET /privacy` (черновик политики, пометка «проверить юристом»), `GET /account` (пока приветствие и ссылка выхода).
- Новый аккаунт требует `consent=on`; успешная проверка кода создаёт «свежую» сессию (`fresh: true`), cookie `httpOnly`, `sameSite: lax`.
- Ответ на `sms/send` одинаков для известного и неизвестного номера; сбой провайдера: страница с понятной ошибкой, не 500; лимиты через `CodeError` → 429 с текстом «Слишком часто, попробуйте позже».

- [ ] **Step 1: Тесты** (`SMS_PROVIDER: 'smsru'`, `SMS_API_URL` фейка).
```js
let r = await c.post('/login/sms/send', { phone: '8 (916) 000-00-01', consent: 'on' });
assert.equal(r.status, 200); assert.equal(sms.calls.length, 1);
const code = /(\d{6})/.exec(sms.calls[0].msg)[1];
r = await c.post('/login/sms/verify', { phone: '+7 916 000 00 01', code });   // другое написание того же номера
assert.equal(r.status, 302); assert.equal(r.location, '/account');
assert.match((await c.get('/account')).text, /Кабинет|Здравствуйте/);
// тот же номер в третьем написании '916-000-00-01' входит в тот же аккаунт: customers с этим phone ровно одна
// без consent: 422 и SMS не уходит; неверный код: 422; десятая отправка подряд -> 429
// выход: POST /account/logout -> cookie снят, /account -> 302 /login
// сфабрикованный cookie cs=abc игнорируется, /account -> 302 /login
// без SMS_PROVIDER вкладки SMS нет, /login/sms/send -> 404
// /account и /login: Cache-Control no-store; robots.txt содержит Disallow: /account и /login
// старый гостевой заказ на тот же телефон (customer_id уже есть) виден после входа (проверит Task 10)
```
- [ ] **Step 2:** FAIL. **Step 3:** реализовать; иконку «user» добавить в спрайт витрины, если её там нет. **Step 4:** PASS, полный `npm test`.
- [ ] **Step 5:** Commit «Витрина: сессии покупателей и вход по SMS».

### Task 8: Вход и привязка через Telegram

**Files:** Modify `src/routes/account.js`, `src/accountviews.js`; Test `test/login.test.js`.

**Interfaces — Produces:** `POST /login/telegram/start {consent}` → страница с кнопкой-ссылкой на бота (`bot.createLink({ purpose: 'login' })`) и формой кода (скрытое поле `token`); `POST /login/telegram/verify {token, code}`: `codes.verify({ purpose: 'tg', target: token, code })`, затем по строке `tg_login` (`phone`, `telegram_id`, не `consumed`) `ensureByVerifiedPhone`, `bindTelegram` (конфликт `tg-taken` — понятная ошибка), свежая сессия, строка `tg_login` гасится.

- [ ] **Step 1: Тесты** (с `bot.handleUpdate` вместо реального Telegram).
```js
let r = await c.post('/login/telegram/start', { consent: 'on' });
const token = /data-tg-token="([^"]+)"/.exec(r.text)[1];
await bot.handleUpdate(startUpdate(token, { from: 555 })); await bot.handleUpdate(contactUpdate({ from: 555, contactUser: 555, phone: '+79160000002' }));
const code = lastCodeFrom(tg);
r = await c.post('/login/telegram/verify', { token, code });
assert.equal(r.status, 302);
const cust = await accounts.byPhone('79160000002'); assert.equal(String(cust.telegram_id), '555');
// второй вход с тем же telegram: бот выдаёт код без контакта
// чужой токен/неверный код: 422; повтор того же кода: 422
// без consent: 422, строка tg_login не создаётся
```
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit «Вход через Telegram-бота».

### Task 9: Пароль, «Забыли пароль», профиль

**Files:** Modify `src/routes/account.js`, `src/accountviews.js`; Test `test/login.test.js`.

**Interfaces — Produces:**
- `POST /login/password {login, password}`: `accounts.byLogin` + `checkPassword`; обычная (не свежая) сессия; ограничители из Global Constraints; ошибка одна для «нет такого» и «неверный пароль».
- `GET /account/welcome` и `POST /account/welcome {email, password}` (после первого входа без пароля; ссылка «Пропустить»); `GET/POST /account/profile {name, email}` (`email-taken` и `bad-email` — понятные ошибки; смена почты отправляет письмо подтверждения, если почта настроена); `GET /login/verify-email/:token` (`codes.consumeToken({ purpose: 'verify-email' })` → `markEmailVerified`).
- `GET/POST /account/password {old?, password, password2}`: старый пароль не требуется, если сессия «свежая» или пароля ещё нет; после смены `destroyAll(customerId, exceptToken)` и новая сессия.
- `GET /login/forgot`: три кнопки — «Код в Telegram» (`/login?tab=tg&next=/account/password`), «Код по SMS» (`…tab=sms…`), «Ссылка на почту» (форма `POST /login/forgot/mail {login}`); показываются только настроенные каналы. `POST /login/forgot/mail` всегда отвечает «Если такой аккаунт есть, письмо отправлено»; письмо уходит только при подтверждённой почте аккаунта: ссылка `/login/reset/:token` (токен на 1 час), `GET` показывает кнопку, `POST /login/reset {token}` создаёт свежую сессию и ведёт на `/account/password`.

- [ ] **Step 1: Тесты.**
```js
// вход паролем по телефону и по почте (в разном регистре)
// 5 неверных паролей -> 6-я попытка с верным паролем даёт 429 (общий текст); сообщение для неизвестного логина совпадает по тексту с неверным паролем
// weak password < 8: 422 'не короче 8'; занятая почта: 422
// forgot для неизвестной почты/телефона: тот же текст ответа и mail.calls.length === 0, sms.calls.length === 0
// forgot для аккаунта с подтверждённой почтой: письмо со ссылкой; ссылка работает один раз; после неё /account/password без старого пароля
// смена пароля: старая сессия другого устройства -> 302 /login; текущая жива
// почта не подтверждена: письмо для сброса не уходит
// вход по SMS-коду (свежая сессия) позволяет сменить пароль без старого; обычная сессия требует старый
```
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit «Пароли, «Забыли пароль», профиль и подтверждение почты».

### Task 10: Кабинет

**Files:** Modify `src/routes/account.js`, `src/accountviews.js`, `public/css/account.css`; Test `test/login.test.js`.

**Interfaces — Produces:** `GET /account` показывает карту (номер `cardNo`, уровень, процент, шкала `spent / next.from`, «до «Золото» осталось …», пометка личной скидки) и список заказов клиента (номер, дата, сумма, статус, ссылка `/order/<номер>?t=<токен>` собирается сервером, самые новые сверху); `GET /account/telegram` + `POST /account/telegram/link` (создаёт `bot.createLink({ purpose: 'link', customerId })` и показывает ссылку с формой кода), `POST /account/telegram/verify {token, code}` (привязка через `bindTelegram`), `POST /account/telegram/unlink`, `POST /account/telegram/notify {on}`; раздел скрыт, если бот не настроен.

- [ ] **Step 1: Тесты.** Клиент с тремя заказами (delivered 40 000 ₽, paid, cancelled) видит «Серебро», «3%», 40 000 в шкале и ссылки на все три заказа, чужих заказов нет; гостевой заказ, оформленный до регистрации на тот же телефон, виден; привязка Telegram: номер Telegram другой → бот отказывает, `telegram_id` не меняется; отвязка очищает `telegram_id`; переключатель уведомлений меняет `tg_notify`.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать (стили в стиле оформления v3, карта крупно на первом экране). **Step 4:** PASS.
- [ ] **Step 5:** Commit «Личный кабинет: карта лояльности, заказы, привязка Telegram».

### Task 11: Скидка при оформлении

**Files:** Modify `src/orders.js` (`createOrder`), `src/routes/cart.js` (корзина, оформление, `/api/cart`, страница заказа), `public/js/shop.js` (пересчёт итога с вычетом скидки), `src/notify.js` (`orderText`: строка «Скидка»), `src/admin/orders.js` (строка скидки в карточке заказа); Move `placeOrder` из `test/notify.test.js` в `test/helpers.js`; Test `test/loyalty-checkout.test.js`.

**Interfaces — Consumes:** `computeDiscount`, `effectivePct`, `statusOf` (Task 2), `req.ctx.customer` (Task 7). **Produces:** `createOrder(db, { …, account })` с `account = { customerId, pct, note, rules } | undefined`: внутри транзакции `discount = computeDiscount(lines, pct, rules).discount`, `total = subtotal − discount + form.deliveryCost`, пишутся `discount`, `discount_pct`, `discount_note`; `customer_id = account.customerId` без upsert по телефону из формы. Пороги бесплатной доставки считаются по сумме до скидки. Корзина и оформление показывают строку «Скидка N%: −X ₽», гостю — «Войдите: скидка до 7%», если лояльность включена. `/api/cart` добавляет `discount`.

- [ ] **Step 1: Тесты.**
```js
// вошедший с накоплением 40 000 ₽ (Серебро): заказ на 10 000 ₽ товаров без акции + доставка 500
//   -> order.discount = 300, total = 10 200, discount_pct = 3, note содержит 'Серебро'
// гость с телефоном этого же клиента: discount = 0, total = 10 500 (скидка не по номеру)
// строка с oldPrice > 0: в базу скидки нет; смесь акционной и обычной: скидка только с обычной
// все строки акционные: discount = 0, на странице заказа нет строки «Скидка»
// товар партнёра (EXT_BASE+) получает скидку; при applyToElectronics=false - нет
// ровно порог 30 000 ₽: «Серебро»; 29 999 ₽: 0%
// личная скидка 10% больше уровня 3%: применяется 10%, не 13%
// получатель с другим телефоном: orders.customer_id = аккаунт, новый customers с чужим телефоном не создаётся
// loyalty.enabled=false: скидки нет у всех
// /api/cart для вошедшего содержит discount; уведомление сотрудникам содержит строку «Скидка»
// гостевой заказ без изменений: прежние тесты shop.test.js зелёные
```
- [ ] **Step 2:** FAIL. **Step 3:** реализовать; итог на странице оформления пересчитывается в `shop.js` по `data-sum-discount`. **Step 4:** PASS, полный `npm test`.
- [ ] **Step 5:** Commit «Скидка лояльности при оформлении заказа».

### Task 12: Статусы заказа покупателям в Telegram

**Files:** Modify `src/notify.js` (зависимость `bot`, новый вид `cust_status`), `src/app.js` (создать бота до уведомлений), `src/admin/orders.js` (в транзакции смены статуса), `src/payments.js` (оплата картой); Test `test/customer-notify.test.js`.

**Interfaces — Produces:** `notifier.enqueueCustomerStatus(client, orderId, status)`: записывает в `outbox` (`kind='cust_status'`, `payload=status`) только если у клиента заказа есть `telegram_id`, `tg_notify` и бот включён; статусы кроме `new`. Доставка: сообщение «Заказ №N: <название статуса>» плюс ссылка на заказ при заданном `PUBLIC_URL`; 403 от Telegram → запись закрывается с пометкой `blocked`, у клиента `tg_notify = false`; остальные сбои повторяются по общему расписанию. Работа очереди требует только токен бота (для сотрудников по-прежнему и чаты).

- [ ] **Step 1: Тесты.** Смена статуса в админке на «Собран» создаёт сообщение на `telegram_id` клиента; клиенту без Telegram или с выключенными уведомлениями ничего не уходит и запись не создаётся; повтор того же статуса не дублирует; 403 → запись закрыта, `tg_notify` выключен, очередь не зациклена; оплата картой (`handleNotify`) создаёт сообщение «Оплачен»; сотрудники по-прежнему получают свои уведомления.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS, `npm test`.
- [ ] **Step 5:** Commit «Покупателям: статусы заказа в Telegram».

### Task 13: Админка

**Files:** Create `src/admin/loyalty.js`; Modify `src/admin/routes.js`, `src/admin/layout.js` (пункт «Лояльность»), `src/admin/auth.js` (право `loyalty: ['owner']`), `src/admin/customers.js`, `src/admin/manage.js` (блок «Вход покупателей» в настройках); Test `test/admin-loyalty.test.js`.

**Interfaces — Produces:** `GET/POST /admin/loyalty` (форма уровней и переключателей через `validateLoyalty`, сохранение `settings.set({ loyalty })`, ошибки показываются без потери введённого); список клиентов получает колонку «Уровень»; карточка клиента показывает номер карты, уровень, накопленную сумму, привязку Telegram и форму `POST /admin/customers/:id/discount {percent}` (владелец, 0–100); `POST /admin/settings/test-sms {phone}` отправляет тестовое SMS; блок статуса: бот (имя), SMS (провайдер, отправлено за 24 часа из `auth_codes`), почта.

- [ ] **Step 1: Тесты.** Владелец сохраняет новые уровни, оформление заказа подхватывает их (после `settings.invalidate()`); неверные пороги — ошибка и ничего не сохранено; менеджер получает отказ на `/admin/loyalty` и на выдачу личной скидки; личная скидка 10% действует на следующий заказ; в списке и в карточке виден уровень; без токена CSRF форма отклоняется; тестовое SMS уходит на фейк.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS.
- [ ] **Step 5:** Commit «Админка: настройка лояльности, личные скидки, статус каналов входа».

### Task 14: Документация и итоговая проверка

**Files:** Modify `README.md` (раздел «Личный кабинет и лояльность»: как включить бота, SMS, почту; число тестов), `.env.example` (если не закрыто в Task 1).

- [ ] **Step 1:** `npm test` — все тесты зелёные; число тестов записать в README.
- [ ] **Step 2:** Прогнать вручную в браузере через Playwright (`SMS_PROVIDER=console`, поддельный Telegram): вход по SMS, привязка Telegram, оформление заказа со скидкой на десктопе и телефоне, снять скриншоты кабинета; убедиться, что нет нарушений CSP в консоли.
- [ ] **Step 3:** `git push -u origin claude/gifted-cerf-jn9e4y`; в итоговом отчёте явно перечислить «не проверено вживую»: SMS.ru и SMTP (нужны ключи), реальный Telegram (нужен бот), вид писем в почтовых клиентах.
- [ ] **Step 4:** Commit «Документация: кабинет, лояльность, настройка каналов».
