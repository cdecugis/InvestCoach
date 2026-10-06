import { config } from '../../config/env.js';
import { buildDailySummary } from './summary.js';

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
  const summary = report.summary ?? buildDailySummary(report.recommendations ?? []);
  add('ACTION DU JOUR', [summary.headline, summary.explanation,
    'Propositions de simulation uniquement. Aucune instruction envoyée à un broker réel.']);
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
  for (const [title, records] of [['Actions BUY — achats proposés', summary.buys], ['Actions SELL — ventes proposées', summary.sells], ['Positions HOLD — conserver', summary.holds]]) {
    add(title, records.length ? records.flatMap(record => {
      const review = record.review ?? config.strategy.review;
      return [
        `${record.action} — ${record.symbol ?? record.instrumentId} — ${record.classification ?? 'sans classification'}`,
        `Score réel : ${number(record.score) ? record.score.toFixed(1) : 'indisponible'}/100 ; technicalScore : ${number(record.technicalScore) ? record.technicalScore.toFixed(1) : 'indisponible'}/100 ; couverture : ${number(record.dataCoveragePct) ? record.dataCoveragePct + ' %' : 'indisponible'}.`,
        `Montant proposé : ${eur(record.proposedAmountEur)} ; quantité : ${number(record.proposedQuantity) ? record.proposedQuantity : 'non proposée'}.`,
        `Niveau de risque : ${labelRisk(record.riskLevel)} ; confiance (couverture des données, pas probabilité de gain) : ${percent(record.confidence)}.`,
        `Raisons positives : ${(record.positiveReasons ?? []).join(' ; ') || 'aucune signalée'}.`,
        `Principaux risques : ${(record.mainRisks ?? []).join(' ; ') || 'aucun risque supplémentaire documenté'}.`,
        `Décision : ${(record.reasons ?? []).join(' ; ') || 'aucune raison renseignée'}.`,
        `Horizon : ${record.horizon ?? config.strategy.risk.horizon}.`,
        `Seuils de réévaluation : ${review.stopReviewPct} % / +${review.takeProfitReviewPct} % ; aucune vente automatique.`,
        `Réanalyse déclenchée : ${review.required ? (review.triggers ?? []).join(', ') : 'non'}.`,
      ];
    }) : ['Aucune.']);
  }
  add('TOP 5 WATCH — observation, aucune nouvelle décision', summary.watch.length ? summary.watch.flatMap(record => [
    `${record.symbol} — ${record.score.toFixed(1)} / technical ${number(record.technicalScore) ? record.technicalScore.toFixed(1) : 'indisponible'} — ${record.classification} — risque ${labelRisk(record.riskLevel)}.`,
    `Couverture : ${number(record.dataCoveragePct) ? record.dataCoveragePct + ' %' : 'indisponible'} ; écart au seuil BUY ${record.buyThreshold} : ${record.gapToBuy} points.`,
    `Raisons positives : ${(record.positiveReasons ?? []).join(' ; ') || 'aucune signalée'}.`,
    `Principaux risques : ${(record.mainRisks ?? []).join(' ; ') || 'aucun documenté'}. Facteurs manquants : ${(record.missingFactors ?? []).join(', ') || 'aucun'}.`,
  ]) : ['Aucun candidat exploitable sous le seuil BUY.']);
  add('NO_ACTION', [`${summary.noActionCount} actif(s) sans transaction justifiée. WATCH reste un affichage ; le score technique ne déclenche aucun ordre.`]);
  add('Transactions virtuelles réalisées', (report.executedTransactions ?? []).length
    ? report.executedTransactions.map(trade => `${trade.side} ${trade.symbol ?? trade.instrumentId} : ${eur(trade.amountEur)}.`)
    : ['Aucune exécution enregistrée. Les propositions ci-dessus ne sont pas des transactions.']);
  const subject = `InvestmentAdvisor — ${String(report.date ?? '')} — ${summary.headline} — PAPER_TRADING`.replace(/[\r\n]/g, '');
  const text = sections.map(section => `${section.title}\n${section.lines.join('\n')}`).join('\n\n');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;color:#172033"><h1>InvestmentAdvisor</h1>${sections.map((section, index) => `<section${index === 0 ? ' style="background:#fff1d6;padding:16px;border-left:6px solid #cf8200"' : ''}><h2>${escapeHtml(section.title)}</h2>${section.lines.map((line, lineIndex) => `<p${index === 0 && lineIndex === 0 ? ' style="font-size:22px;font-weight:bold"' : ''}>${escapeHtml(line)}</p>`).join('')}</section>`).join('')}</body></html>`;
  return { subject, html, text };
}

/** Envoi indépendant des transactions ; réservation outbox effectuée par l'orchestrateur. */
export async function sendDailyEmail(message, { enabled = config.email.enabled, transport = null, idempotencyKey } = {}) {
  if (!enabled) return { sent: false };
  if (!transport || !idempotencyKey) throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
  const result = await transport.send(message, { idempotencyKey });
  return { sent: true, providerMessageId: result?.messageId ?? null };
}
