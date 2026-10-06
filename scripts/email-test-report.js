import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { InvestmentRepository } from '../src/db/investmentRepository.js';
import { buildDailyReport } from '../src/modules/email/report.js';
import { renderDailyEmail } from '../src/modules/email/index.js';
import { createEmailTransport, readEmailSettings, parseRecipients, EmailConfigurationError } from '../src/modules/email/transport.js';
import { redactLogText } from '../src/shared/error-log.js';

/** Lecture seule : aucun job, recalcul, ordre ou accès à l'outbox. */
export async function runEmailTestReport({ env = process.env,
  repositoryFactory = () => new InvestmentRepository(), transportFactory = createEmailTransport,
  log = console.log, logError = console.error } = {}) {
  log('[EMAIL] manual test report — lecture seule, envoi manuel hors outbox');
  try {
    const settings = readEmailSettings(env);
    if (!settings.enabled) throw new EmailConfigurationError('EMAIL_DISABLED', 'EMAIL_ENABLED=false : aucun email envoyé.');
    const transport = transportFactory(settings, {}, { env });
    const source = await repositoryFactory().getLatestCompletedReport();
    const report = buildDailyReport(source);
    const message = renderDailyEmail(report);
    // Envoi volontaire par invocation manuelle ; ne réserve ni ne modifie l'outbox.
    await transport.send({ ...message, from: settings.from, to: parseRecipients(settings.to),
      subject: `InvestCoach — test rapport complet — ${String(report.date).replace(/[\r\n]/g, '')}` });
    log('Email sent successfully — manual test report');
    return 0;
  } catch (error) {
    const clean = value => {
      let text = String(value ?? '');
      // Nettoyer aussi les erreurs de lecture DB, sans afficher de credentials.
      for (const secret of [env.SMTP_PASSWORD, env.SUPABASE_SECRET_KEY]) {
        if (!secret) continue;
        text = text.split(secret).join('[REDACTED]');
        text = text.split(Buffer.from(secret).toString('base64')).join('[REDACTED]');
      }
      return redactLogText(text);
    };
    logError({ name: clean(error?.name ?? 'Error'), message: clean(error?.message ?? 'Échec du test rapport email.'),
      code: error?.code ? clean(error.code) : undefined,
      responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined });
    return 1;
  }
}

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv.config({ quiet: true });
  process.exitCode = await runEmailTestReport();
}
