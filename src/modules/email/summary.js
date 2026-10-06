import { config } from '../../config/env.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 10) / 10;
const displayRecord = record => Object.fromEntries([
  'instrumentId', 'symbol', 'action', 'score', 'finalScore', 'technicalScore', 'dataCoveragePct',
  'classification', 'riskLevel', 'confidence', 'positiveReasons', 'mainRisks', 'reasons', 'missingFactors',
  'proposedAmountEur', 'proposedQuantity', 'horizon', 'review', 'buyThreshold', 'gapToBuy',
].filter(key => record[key] !== undefined).map(key => [key, record[key]]));

/** Présentation uniquement : ne remplace jamais le score ni la décision persistés. */
export function enrichRecommendation(record, buyThreshold = config.strategy.signals.buyScore) {
  const components = record.components ?? record.decisionContext?.components ?? {};
  const entries = Object.entries(components);
  const totalWeight = entries.reduce((sum, [, item]) => sum + (finite(item.weight) && item.weight > 0 ? item.weight : 0), 0);
  const available = entries.filter(([, item]) => finite(item.score) && finite(item.weight) && item.weight > 0);
  const availableWeight = available.reduce((sum, [, item]) => sum + item.weight, 0);
  const weightedScore = available.reduce((sum, [, item]) => sum + item.score * item.weight, 0);
  return { ...record, finalScore: record.score,
    technicalScore: availableWeight > 0 ? round(weightedScore / availableWeight) : null,
    dataCoveragePct: totalWeight > 0 ? round(availableWeight / totalWeight * 100) : null,
    missingFactors: record.missing ?? entries.filter(([, item]) => !finite(item.score)).map(([name]) => name),
    buyThreshold, gapToBuy: finite(record.score) ? round(Math.max(0, buyThreshold - record.score)) : null };
}

export function buildDailySummary(recommendations, buyThreshold = config.strategy.signals.buyScore) {
  const records = recommendations.filter(record => record.instrumentId).map(record => displayRecord(enrichRecommendation(record, buyThreshold)));
  const buys = records.filter(record => record.action === 'BUY');
  const sells = records.filter(record => record.action === 'SELL');
  const holds = records.filter(record => record.action === 'HOLD');
  const noActions = records.filter(record => record.action === 'NO_ACTION');
  const watch = noActions.filter(record => finite(record.score) && record.score < buyThreshold)
    .sort((a, b) => b.score - a.score || String(a.symbol).localeCompare(String(b.symbol))).slice(0, 5);
  const actionRequired = buys.length + sells.length > 0;
  const headline = actionRequired ? [...buys.map(record => `ACHETER ${record.symbol} — ${finite(record.proposedAmountEur) ? record.proposedAmountEur.toFixed(2) + ' EUR' : 'montant indisponible'}`),
    ...sells.map(record => `VENDRE ${record.symbol} — ${finite(record.proposedAmountEur) ? record.proposedAmountEur.toFixed(2) + ' EUR' : 'montant indisponible'}`)].join(' ; ')
    : 'AUCUNE OPÉRATION AUJOURD’HUI';
  return { actionRequired, headline, buys, sells, holds, watch, noActionCount: noActions.length,
    explanation: actionRequired ? 'Propositions PAPER_TRADING ; les exécutions réalisées sont indiquées séparément.'
      : `Aucun BUY/SELL validé par les règles existantes. Seuil BUY : ${buyThreshold}/100. Le score technique est informatif et ne déclenche aucun achat.` };
}
