import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { createEmailTransport, readEmailSettings, parseRecipients, EmailConfigurationError } from '../src/modules/email/transport.js';
import { redactLogText } from '../src/shared/error-log.js';

/** Test indépendant : aucune importation du moteur ni de Supabase. */
export async function runEmailTest({ env = process.env, transportFactory = createEmailTransport,
  log = console.log, logError = console.error } = {}) {
  try {
    const settings = readEmailSettings(env);
    if (!settings.enabled) throw new EmailConfigurationError('EMAIL_DISABLED', 'EMAIL_ENABLED=false : aucun email envoyé.');
    const transport = transportFactory(settings, {}, { env });
    await transport.send({ from: settings.from, to: parseRecipients(settings.to),
      subject: 'InvestCoach — test email', text: "Test d'envoi SMTP InvestmentAdvisor réussi.",
      html: '<p>Test d&#39;envoi SMTP InvestmentAdvisor réussi.</p>' });
    log('Email sent successfully');
    return 0;
  } catch (error) {
    const clean = value => {
      let text = String(value ?? '');
      const password = env.SMTP_PASSWORD;
      if (password) {
        text = text.split(password).join('[REDACTED]');
        text = text.split(Buffer.from(password).toString('base64')).join('[REDACTED]');
      }
      return redactLogText(text);
    };
    logError({ name: clean(error?.name ?? 'Error'), message: clean(error?.message ?? 'Échec du test email.'),
      code: error?.code ? clean(error.code) : undefined,
      responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined });
    return 1;
  }
}

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv.config({ quiet: true });
  process.exitCode = await runEmailTest();
}
