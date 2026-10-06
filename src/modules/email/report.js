import { config } from '../../config/env.js';
import { InvestmentRepository } from '../../db/investmentRepository.js';
import { errorLogEntry } from '../../shared/error-log.js';
import { buildDailySummary, enrichRecommendation } from './summary.js';
import { renderDailyEmail, sendDailyEmail } from './index.js';
import { createEmailTransport, parseRecipients, EmailConfigurationError } from './transport.js';

export function buildDailyReport(result, settings = config) {
  const buyThreshold = result.recommendations?.find(record => record.decisionContext?.strategy)?.decisionContext.strategy.signals?.buyScore
    ?? settings.strategy.signals.buyScore;
  const recommendations = (result.recommendations ?? []).map(record => enrichRecommendation(record, buyThreshold));
  const summary = buildDailySummary(recommendations, buyThreshold);
  return { ...result, recommendations, summary,
    totalValueEur: result.portfolio?.totalValueEur, cashEur: result.portfolio?.cashEur,
    cumulativeReturn: result.performance?.cumulativeReturn, positions: result.portfolio?.positions ?? [],
      emailRendered: false, emailSent: false, emailStatus: 'disabled', errors: [...(result.errors ?? [])] };
}

/** Appelé seulement APRÈS le retour réussi/finalisé du moteur. Aucun retry du moteur. */
export async function produceDailyReport(result, options = {}) {
  const settings = options.settings ?? config;
  const emailSettings = settings.email ?? { enabled: false, to: '', from: '', provider: '' };
  let repository = options.repository;
  let report;
  let claimed = false;
  try {
    if (result.status === 'already_completed') {
      repository ??= new InvestmentRepository();
      result = await repository.getCompletedReport(result.runId);
    }
    report = buildDailyReport(result, settings);
    report.email = renderDailyEmail(report);
    report.emailRendered = true;
    if (report.dryRun) { report.emailStatus = 'dry_run'; return report; }
    if (!report.runId) throw new Error('Rapport sans identifiant de run finalisé.');
    const recipients = parseRecipients(emailSettings.to);
    if (!recipients.length) {
      if (emailSettings.enabled) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'Variables email manquantes : EMAIL_TO.');
      return report;
    }
    repository ??= new InvestmentRepository();
    const stored = await repository.enqueueEmail(report.runId, recipients.join(', '), report.email);
    report.email = { subject: stored.subject, html: stored.html_body, text: stored.text_body };
    report.emailSent = emailSettings.enabled && stored.status === 'sent';
    report.emailStatus = stored.status;
    if (!emailSettings.enabled) { report.emailStatus = 'disabled'; return report; }
    if (stored.status !== 'pending') return report;
    if (!emailSettings.from?.trim()) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'Variables email manquantes : EMAIL_FROM.');
    if (/[\r\n]/.test(emailSettings.from + stored.recipient)) throw new EmailConfigurationError('EMAIL_CONFIGURATION_INVALID', 'EMAIL_FROM/EMAIL_TO : saut de ligne interdit.');
    const transport = options.emailTransport ?? createEmailTransport({ ...emailSettings, to: stored.recipient });
    if (typeof transport?.send !== 'function') throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
    const reserved = await repository.claimEmail(report.runId);
    if (!reserved) {
      const current = await repository.getEmailReport(report.runId);
      report.emailStatus = current?.status ?? 'unavailable';
      report.emailSent = current?.status === 'sent';
      return report;
    }
    claimed = true;
    report.emailStatus = 'sending';
    const delivery = await sendDailyEmail({ ...report.email, from: emailSettings.from, to: reserved.recipient },
      { enabled: true, transport, idempotencyKey: `investmentadvisor:${report.runId}` });
    report.emailSent = delivery.sent;
    if (!delivery.sent) throw new Error('EMAIL_DELIVERY_FAILED');
    await repository.completeEmail(report.runId, delivery.providerMessageId);
    report.emailStatus = 'sent';
    return report;
  } catch (error) {
    (options.logError ?? console.error)(errorLogEntry('daily_report_failed', error));
    // Une panne de rendu/outbox/transport ne marque JAMAIS le run comme échoué.
    if (!report) {
      report = { ...result, summary: { actionRequired: false, headline: 'Rapport indisponible — analyse déjà finalisée',
        buys: [], sells: [], holds: [], watch: [], noActionCount: 0, available: false },
      emailRendered: false, emailSent: false, errors: [] };
    }
    const configurationCodes = ['EMAIL_PROVIDER_NOT_CONFIGURED', 'EMAIL_PROVIDER_UNSUPPORTED', 'EMAIL_CONFIGURATION_INVALID', 'EMAIL_RECIPIENT_NOT_CONFIGURED', 'EMAIL_ADDRESS_NOT_CONFIGURED'];
    const configurationCode = configurationCodes.find(code => error?.code === code || error?.message === code);
    const configurationError = Boolean(configurationCode);
    report.emailStatus = report.emailSent ? 'sent_unconfirmed' : claimed ? 'failed' : configurationError ? 'not_configured' : 'unavailable';
    report.errors.push({ code: configurationCode ?? 'EMAIL_REPORT_FAILED', message: configurationError ? error.message
      : 'Analyse finalisée ; rapport ou livraison email indisponible. Aucun run ni ordre rejoué.' });
    if (claimed && !report.emailSent) {
      try { await repository.failEmail(report.runId); }
      catch (failure) { (options.logError ?? console.error)(errorLogEntry('email_outbox_update_failed', failure)); }
    }
    return report;
  }
}
