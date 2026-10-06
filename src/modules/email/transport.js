import nodemailer from 'nodemailer';
import { redactLogText } from '../../shared/error-log.js';

export class EmailConfigurationError extends Error {
  constructor(code, message) { super(message); this.name = 'EmailConfigurationError'; this.code = code; }
}

/** Adresses simples séparées par virgule/point-virgule, doublons sans casse. */
export function parseRecipients(value) {
  const seen = new Set();
  const recipients = [];
  for (const item of (Array.isArray(value) ? value : [value ?? ''])) {
    for (const entry of String(item).split(/[,;]/)) {
      const address = entry.trim();
      if (!address) continue;
      if (/[\r\n]/.test(address)) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'EMAIL_TO ne doit pas contenir de saut de ligne.');
      const key = address.toLowerCase();
      if (!seen.has(key)) { seen.add(key); recipients.push(address); }
    }
  }
  return recipients;
}

export function readEmailSettings(env = process.env) {
  const enabled = env.EMAIL_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'EMAIL_ENABLED doit être true ou false.');
  return { enabled: enabled === 'true', provider: env.EMAIL_PROVIDER ?? '', from: env.EMAIL_FROM ?? '', to: env.EMAIL_TO ?? '' };
}

/** Le mot de passe est lu au dernier moment ; jamais dans config, rapport ou DB. */
function smtpConfiguration(settings, env) {
  if (!settings.provider?.trim()) throw new EmailConfigurationError('EMAIL_PROVIDER_NOT_CONFIGURED', 'EMAIL_PROVIDER_NOT_CONFIGURED : renseigner EMAIL_PROVIDER.');
  if (settings.provider !== 'gmail-smtp') throw new EmailConfigurationError('EMAIL_PROVIDER_UNSUPPORTED', 'EMAIL_PROVIDER non supporté. Utiliser gmail-smtp.');
  const recipients = parseRecipients(settings.to);
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'].filter(name => !String(env[name] ?? '').trim());
  if (!settings.from?.trim()) missing.push('EMAIL_FROM');
  if (!recipients.length) missing.push('EMAIL_TO');
  if (missing.length) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', `Variables email manquantes : ${missing.join(', ')}.`);
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'SMTP_PORT doit être un entier entre 1 et 65535.');
  const secure = env.SMTP_SECURE ?? 'false';
  if (!['true', 'false'].includes(secure)) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'SMTP_SECURE doit être true ou false.');
  if (port === 587 && secure !== 'false') throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'SMTP_SECURE doit être false pour SMTP_PORT=587 (STARTTLS).');
  if (/[\r\n]/.test(settings.from + env.SMTP_HOST + env.SMTP_USER)) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'Configuration email : saut de ligne interdit.');
  return { host: env.SMTP_HOST.trim(), port, secure: secure === 'true',
    auth: { user: env.SMTP_USER.trim(), pass: env.SMTP_PASSWORD } };
}

/** Une tentative SMTP ; la réservation atomique de l'outbox protège les doublons. */
export class EmailTransport {
  async send(message, { idempotencyKey } = {}) {
    throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
  }
}

class GmailSmtpTransport extends EmailTransport {
  #mailer;
  #from;
  #secret;
  #user;
  constructor(settings, { env = process.env, createTransport = options => nodemailer.createTransport(options) } = {}) {
    super();
    const smtp = smtpConfiguration(settings, env);
    this.#from = settings.from;
    this.#secret = smtp.auth.pass;
    this.#user = smtp.auth.user;
    this.#mailer = createTransport({ ...smtp, requireTLS: !smtp.secure,
      pool: false, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000 });
  }
  async send(message) {
    try {
      const recipients = parseRecipients(message.to);
      if (!recipients.length) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'EMAIL_TO est vide.');
      const info = await this.#mailer.sendMail({ from: this.#from, to: recipients,
        subject: message.subject, text: message.text, html: message.html });
      if (info.rejected?.length || (Array.isArray(info.accepted) && !info.accepted.length)) {
        const error = new Error('Destinataire(s) SMTP refusé(s). Aucun second envoi automatique.');
        error.code = 'EMAIL_PARTIAL_DELIVERY';
        throw error;
      }
      return { messageId: info.messageId };
    } catch (error) {
      // Ne pas propager le client SMTP, l'auth, la commande AUTH ou la réponse brute.
      const secrets = [this.#secret, Buffer.from(this.#secret).toString('base64'),
        Buffer.from(`\0${this.#user}\0${this.#secret}`).toString('base64'),
        Buffer.from(`${this.#user}\0${this.#user}\0${this.#secret}`).toString('base64')];
      const clean = value => redactLogText(secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value ?? '')));
      const safe = new Error(clean(error?.message ?? 'Échec SMTP.'));
      safe.name = clean(error?.name ?? 'Error');
      if (error?.code) safe.code = clean(error.code);
      if (Number.isInteger(error?.responseCode)) safe.responseCode = error.responseCode;
      throw safe;
    }
  }
}

export function createEmailTransport(settings, providers = {}, dependencies = {}) {
  if (!settings.enabled) return null;
  if (settings.provider && Object.hasOwn(providers, settings.provider)) return providers[settings.provider](settings);
  return new GmailSmtpTransport(settings, dependencies);
}
