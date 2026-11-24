'use strict';
// Отправка SMS с кодами входа. Провайдер выбирается SMS_PROVIDER: smsru (SMS.ru, нужен SMS_API_KEY) или console
// (код пишется в журнал; только для разработки, на боевом сервере запрещён в config.js). Без настройки SMS выключены.
const SEND_TIMEOUT_MS = 8000;

class SmsError extends Error {}

function createSms(cfg, { fetchImpl = fetch, log = console } = {}) {
  const provider = cfg.provider;
  const enabled = () => provider === 'console' || (provider === 'smsru' && Boolean(cfg.apiKey));
  // Ключ - секрет: в тексте ошибок и в журнале его быть не должно
  const scrub = (s) => (cfg.apiKey ? String(s).split(cfg.apiKey).join('***') : String(s));

  async function sendSmsRu(phone, text) {
    const q = new URLSearchParams({ api_id: cfg.apiKey, to: phone, msg: text, json: '1' });
    if (cfg.sender) q.set('from', cfg.sender);
    let res;
    try {
      res = await fetchImpl(`${cfg.apiUrl}/sms/send?${q}`, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch (e) {
      const why = e && e.name === 'TimeoutError' ? `нет ответа за ${SEND_TIMEOUT_MS / 1000} с` : `${e.message}${e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''}`;
      throw new SmsError(scrub(`SMS.ru недоступен: ${why}`));
    }
    if (!res.ok) throw new SmsError(`SMS.ru ответил HTTP ${res.status}`);
    let data = null;
    try { data = await res.json(); } catch { /* ответ не JSON */ }
    const item = data && data.sms && data.sms[phone];
    if (!data || data.status !== 'OK' || !item || item.status !== 'OK') {
      const code = (item && item.status_code) || (data && data.status_code) || '?';
      const text2 = (item && item.status_text) || (data && data.status_text) || 'неизвестная ошибка';
      throw new SmsError(scrub(`SMS.ru отклонил отправку (код ${code}): ${text2}`));
    }
  }

  // phone - номер в виде 7XXXXXXXXXX
  async function send(phone, text) {
    if (!enabled()) throw new SmsError('SMS не настроены');
    if (provider === 'console') { log.log(`[sms] ${phone}: ${text}`); return; }
    await sendSmsRu(phone, text);
  }

  return { enabled, send, provider };
}

module.exports = { createSms, SmsError };
