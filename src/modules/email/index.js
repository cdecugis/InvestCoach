import { NotImplementedError } from '../../shared/not-implemented.js';
import { config } from '../../config/env.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = value => typeof value === 'number' && Number.isFinite(value);
const eur = value => number(value) ? `${value.toFixed(2)} EUR` : 'indisponible';
const percent = value => number(value) ? `${(value * 100).toFixed(2)} %` : 'indisponible';
const labelRisk = value => ({ HIGH: 'ÉLEVÉ', VERY_HIGH: 'TRÈS ÉLEVÉ' })[value] ?? 'non évalué';

/**
 * Fonction pure : { subject, html, text } à partir du rapport journalier.
 * Valeur, cash, performance, benchmark, positions, achats/ventes, raisons,
 * scores ; distinguer propositions, exécutions et NO_ACTION, échapper le HTML.
 */
export function renderDailyEmail(report) {
  const sections = [];
  const add = (title, lines) => sections.push({ title, lines });
  add('Portefeuille', [
    `Mode : PAPER_TRADING — profil ${config.riskProfile} — risque élevé accepté.`,
    `Valeur : ${eur(report.totalValueEur)} ; cash : ${eur(report.cashEur)}.`,
    `Performance cumulée : ${percent(report.cumulativeReturn)}.`,
    `Benchmark : ${report.benchmark?.name ?? 'MSCI World'} ; performance : ${percent(report.benchmark?.cumulativeReturn)} ; date : ${report.benchmark?.priceDate ?? 'indisponible'}.`,
    `Écart au benchmark : ${number(report.cumulativeReturn) && number(report.benchmark?.cumulativeReturn)
      ? `${((report.cumulativeReturn - report.benchmark.cumulativeReturn) * 100).toFixed(2)} points` : 'indisponible'}.`,
  ]);
  add('Positions existantes', (report.positions ?? []).length ? report.positions.map(position =>
    `${position.symbol ?? position.instrumentId} : ${eur(position.marketValueEur)}, poids ${percent(position.weight)}, ${position.classification ?? 'classification non évaluée'}.`) : ['Aucune position.']);
  const recommendations = report.recommendations ?? [];
  for (const record of recommendations) {
    const review = record.review ?? config.strategy.review;
    add(`${record.action} — ${record.symbol ?? record.instrumentId ?? 'Portefeuille'} — ${record.classification ?? 'sans classification'}`, [
      `Score : ${number(record.score) ? `${record.score}/100` : 'indisponible'} ; montant proposé : ${eur(record.proposedAmountEur)}.`,
      `Niveau de risque : ${labelRisk(record.riskLevel)} ; confiance (couverture des données, pas probabilité de gain) : ${percent(record.confidence)}.`,
      `Raisons positives : ${(record.positiveReasons ?? []).join(' ; ') || 'aucune signalée'}.`,
      `Principaux risques : ${(record.mainRisks ?? []).join(' ; ') || 'aucun risque supplémentaire documenté'}.`,
      `Décision : ${(record.reasons ?? []).join(' ; ') || 'aucune raison renseignée'}.`,
      `Horizon : ${record.horizon ?? config.strategy.risk.horizon}.`,
      `Seuils de réévaluation : ${review.stopReviewPct} % / +${review.takeProfitReviewPct} % ; aucune vente automatique.`,
      `Réanalyse déclenchée : ${review.required ? (review.triggers ?? []).join(', ') : 'non'}.`,
    ]);
  }
  if (!recommendations.length) add('NO_ACTION', ['Aucune recommandation fournie ; aucun achat justifié par la seule présence de cash.']);
  add('Transactions virtuelles réalisées', (report.executedTransactions ?? []).length
    ? report.executedTransactions.map(trade => `${trade.side} ${trade.symbol ?? trade.instrumentId} : ${eur(trade.amountEur)}.`)
    : ['Aucune exécution enregistrée. Les propositions ci-dessus ne sont pas des transactions.']);
  const subject = `InvestmentAdvisor — ${String(report.date ?? '').replace(/[\r\n]/g, '')} — ${config.riskProfile} — PAPER_TRADING`;
  const text = sections.map(section => `${section.title}\n${section.lines.join('\n')}`).join('\n\n');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;color:#172033"><h1>InvestmentAdvisor</h1><p style="background:#fff1d6;padding:12px"><strong>PAPER_TRADING · ${escapeHtml(config.riskProfile)} · risque élevé</strong></p>${sections.map(section => `<section><h2>${escapeHtml(section.title)}</h2>${section.lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</section>`).join('')}</body></html>`;
  return { subject, html, text };
}

/** Transport SMTP séparé du rendu ; livraison suivie en base pour les retries. */
export async function sendDailyEmail(message) {
  throw new NotImplementedError('email.sendDailyEmail');
}
