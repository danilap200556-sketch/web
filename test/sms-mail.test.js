'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeSmsRu } = require('./helpers');
const { createSms, SmsError } = require('../src/sms');

const cfgFor = (url, extra = {}) => ({ provider: 'smsru', apiKey: 'SECRETKEY123', sender: '', apiUrl: url, dailyCap: 300, ...extra });

test('SMS.ru: сообщение уходит с ключом, номером и текстом', async () => {
  const api = await fakeSmsRu();
  try {
    const sms = createSms(cfgFor(api.url, { sender: 'SOLEHOUSE' }));
    assert.equal(sms.enabled(), true);
    await sms.send('79160000001', 'Код для входа: 123456');
    assert.deepEqual(api.calls, [{ apiId: 'SECRETKEY123', to: '79160000001', msg: 'Код для входа: 123456', from: 'SOLEHOUSE' }]);
  } finally { await api.close(); }
});

test('SMS.ru: ответ с ошибкой и HTTP 500 дают SmsError без ключа в тексте', async () => {
  const api = await fakeSmsRu();
  try {
    const sms = createSms(cfgFor(api.url));
    api.mode.fail = true;
    await assert.rejects(sms.send('79160000001', 'x'), (e) => e instanceof SmsError && /api_id|200/.test(e.message) && !e.message.includes('SECRETKEY123'));
    api.mode.fail = false; api.mode.http = 500;
    await assert.rejects(sms.send('79160000001', 'x'), (e) => e instanceof SmsError && /500/.test(e.message));
  } finally { await api.close(); }
});

test('SMS.ru: недоступный сервер даёт SmsError и не раскрывает ключ', async () => {
  const sms = createSms(cfgFor('http://127.0.0.1:1'));
  await assert.rejects(sms.send('79160000001', 'x'), (e) => e instanceof SmsError && !e.message.includes('SECRETKEY123'));
});

test('без ключа SMS выключены, режим console пишет код в журнал', async () => {
  const off = createSms(cfgFor('http://x', { apiKey: '' }));
  assert.equal(off.enabled(), false);
  await assert.rejects(off.send('79160000001', 'x'), SmsError);
  assert.equal(createSms(cfgFor('http://x', { provider: '' })).enabled(), false);
  const lines = [];
  const dev = createSms(cfgFor('http://x', { provider: 'console', apiKey: '' }), { log: { log: (l) => lines.push(l) } });
  assert.equal(dev.enabled(), true);
  await dev.send('79160000001', 'Код для входа: 654321');
  assert.match(lines[0], /\[sms\] 79160000001: Код для входа: 654321/);
});

// ---------- Почта ----------
const nodemailer = require('nodemailer');
const { createMail, MailError } = require('../src/mail');

const smtp = { host: 'smtp.example.ru', port: 465, secure: true, user: 'shop@example.ru', pass: 'p', from: 'SOLEHOUSE <shop@example.ru>' };
function jsonTransport() {
  const sent = [];
  const real = nodemailer.createTransport({ jsonTransport: true });
  return { sent, transport: { sendMail: async (m) => { const info = await real.sendMail(m); sent.push(JSON.parse(info.message)); return info; } } };
}

test('почта: письмо собирается с адресом, темой, текстом и отправителем из настроек', async () => {
  const { sent, transport } = jsonTransport();
  const mail = createMail(smtp, { transport });
  assert.equal(mail.enabled(), true);
  await mail.send({ to: 'buyer@x.ru', subject: 'Сброс пароля', text: 'Ссылка: https://shop.example/login/reset/abc' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0].address, 'buyer@x.ru');
  assert.equal(sent[0].from.address, 'shop@example.ru');
  assert.equal(sent[0].subject, 'Сброс пароля');
  assert.match(sent[0].text, /login\/reset\/abc/);
});

test('почта: без настроек выключена и не отправляет', async () => {
  const mail = createMail({ ...smtp, host: '' });
  assert.equal(mail.enabled(), false);
  await assert.rejects(mail.send({ to: 'a@x.ru', subject: 's', text: 't' }), MailError);
});

test('почта: сбой транспорта превращается в MailError без пароля в тексте', async () => {
  const transport = { sendMail: async () => { throw new Error('Invalid login: 535 for pass p'); } };
  const mail = createMail({ ...smtp, pass: 'SECRETPASS' }, { transport });
  await assert.rejects(mail.send({ to: 'a@x.ru', subject: 's', text: 't' }), (e) => e instanceof MailError && !e.message.includes('SECRETPASS'));
});
