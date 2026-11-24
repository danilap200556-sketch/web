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
