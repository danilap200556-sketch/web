'use strict';
// Письма покупателям (сброс пароля, подтверждение почты) по SMTP. Без настроек (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM)
// почта выключена, а сайт предлагает коды по SMS и Telegram.
const nodemailer = require('nodemailer');

class MailError extends Error {}

function createMail(cfg, { transport = null } = {}) {
  const enabled = () => Boolean(cfg.host && cfg.user && cfg.pass && cfg.from);
  let tr = transport;
  const connection = () => tr || (tr = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }));
  // Пароль - секрет: в тексте ошибок его быть не должно
  const scrub = (s) => (cfg.pass ? String(s).split(cfg.pass).join('***') : String(s));

  async function send({ to, subject, text }) {
    if (!enabled()) throw new MailError('Почта не настроена');
    try {
      await connection().sendMail({ from: cfg.from, to, subject, text });
    } catch (e) {
      throw new MailError(scrub(`Письмо не отправлено: ${e.message}`));
    }
  }

  return { enabled, send };
}

module.exports = { createMail, MailError };
