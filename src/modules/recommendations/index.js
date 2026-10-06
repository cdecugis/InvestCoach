import { config } from '../../config/env.js';
import { calculateInvestmentScore, dateDay } from '../scoring/index.js';
import { validateProposedTrade } from '../portfolio/index.js';

export function reviewPosition(position, parameters = config.strategy) {
  const pnlPct = position.costBasisEur > 0
    ? (position.marketValueEur / position.costBasisEur - 1) * 100 : null;
  const triggers = [];
  if (pnlPct !== null && pnlPct <= parameters.review.stopReviewPct) triggers.push('STOP_REVIEW');
  if (pnlPct !== null && pnlPct >= parameters.review.takeProfitReviewPct) triggers.push('TAKE_PROFIT_REVIEW');
  return { ...parameters.review, pnlPct, required: triggers.length > 0, triggers, automaticSale: false };
}

function cooldownDecision(result, lastTrade, side, asOfDate, parameters) {
  if (!lastTrade) return { blocked: false, exception: false };
  const elapsed = (dateDay(asOfDate) - dateDay(lastTrade.tradeDate)) / 86400000;
  if (elapsed >= parameters.cooldown.days) return { blocked: false, exception: false };
  const direction = side === 'BUY' ? 1 : -1;
  const scoreChange = Number.isFinite(lastTrade.scoreAtTrade) && result.score !== null
    && direction * (result.score - lastTrade.scoreAtTrade) >= parameters.cooldown.significantScoreChange;
  const newEvidence = result.catalysts.some(event => dateDay(event.date) > dateDay(lastTrade.tradeDate)
    && direction * event.strength >= parameters.cooldown.significantCatalystStrength);
  return { blocked: !scoreChange && !newEvidence, exception: Boolean(scoreChange || newEvidence) };
}

/**
 * Propositions pures, sans écriture ni exécution. L'historique des transactions
 * exécutées est obligatoire pour le cooldown et la limite journalière.
 */
export function generateRecommendations(context, parameters = config.strategy) {
  const { portfolio, asOfDate, tradeHistory, candidates } = context;
  if (!Number.isFinite(dateDay(asOfDate)) || !Array.isArray(tradeHistory) || !Array.isArray(candidates)
    || !Array.isArray(portfolio?.positions)) throw new Error('Contexte de recommandations incomplet.');
  if (tradeHistory.some(trade => !Number.isFinite(dateDay(trade.tradeDate))
    || dateDay(trade.tradeDate) > dateDay(asOfDate) || !['BUY', 'SELL'].includes(trade.side)
    || typeof trade.instrumentId !== 'string' || !trade.instrumentId)) {
    throw new Error('Historique de transactions invalide.');
  }
  if (candidates.some(candidate => typeof candidate.instrumentId !== 'string' || !candidate.instrumentId)
    || new Set(candidates.map(candidate => candidate.instrumentId)).size !== candidates.length) {
    throw new Error('Instruments candidats invalides ou dupliqués.');
  }
  let usedSlots = tradeHistory.filter(trade => trade.tradeDate === asOfDate).length;
  const plannedPortfolio = structuredClone(portfolio);
  const universe = [...candidates];
  for (const position of portfolio.positions) {
    if (!universe.some(candidate => candidate.instrumentId === position.instrumentId)) {
      universe.push({ instrumentId: position.instrumentId, symbol: position.symbol, indicators: {} });
    }
  }
  const evaluated = universe.map(candidate => ({ candidate,
    result: calculateInvestmentScore(candidate.indicators ?? {}, parameters) }));
  // Ventes d'abord, puis meilleurs scores ; départage stable par identifiant.
  evaluated.sort((a, b) => {
    const sellRank = item => portfolio.positions.some(p => p.instrumentId === item.candidate.instrumentId)
      && item.result.score !== null && item.result.score <= parameters.signals.sellScore ? 1 : 0;
    return sellRank(b) - sellRank(a) || (b.result.score ?? -1) - (a.result.score ?? -1)
      || String(a.candidate.symbol ?? a.candidate.instrumentId).localeCompare(String(b.candidate.symbol ?? b.candidate.instrumentId));
  });
  const recommendations = [];
  const noTradeReasons = [];
  for (const { candidate, result } of evaluated) {
    const position = portfolio.positions.find(item => item.instrumentId === candidate.instrumentId);
    const review = position ? reviewPosition(position, parameters)
      : { ...parameters.review, required: false, triggers: [], automaticSale: false };
    const reasons = [...result.reasons];
    if (candidate.dataError) reasons.push(`Source indisponible : ${candidate.dataError}`);
    const record = {
      instrumentId: candidate.instrumentId, symbol: candidate.symbol ?? candidate.instrumentId,
      action: position ? 'HOLD' : 'NO_ACTION', ...result,
      reasons, positiveReasons: [...result.reasons], mainRisks: [...result.risks],
      proposedAmountEur: null, proposedQuantity: null, review,
      decisionContext: { riskProfile: config.riskProfile, modelVersion: result.modelVersion, asOfDate,
        signalDate: candidate.indicators?.lastPriceDate ?? asOfDate,
        components: result.components, catalysts: result.catalysts, review, strategy: parameters },
    };
    if (review.required) reasons.push(`Réanalyse ${review.triggers.join(', ')} ; aucune vente automatique.`);
    const fresh = result.asOfDate === asOfDate && result.score !== null
      && result.confidence >= parameters.signals.minConfidence;
    const cscore = name => result.components[name]?.score ?? -1;
    const buySignal = candidate.buyAllowed !== false && fresh && result.score >= parameters.signals.buyScore
      && cscore('momentum1m') >= parameters.signals.minMomentumScore
      && cscore('momentum3m') >= parameters.signals.minMomentumScore
      && ['acceleration', 'unusualVolume', 'breakout', 'catalysts']
        .some(name => cscore(name) >= parameters.signals.minConfirmationScore);
    const sellSignal = fresh && result.score <= parameters.signals.sellScore;
    const side = position && sellSignal ? 'SELL' : buySignal ? 'BUY' : null;
    if (!side) reasons.push(fresh ? 'Signal insuffisant pour une transaction.' : 'Données ou confiance insuffisantes pour décider.');
    else {
      const lastTrade = tradeHistory.filter(trade => trade.instrumentId === candidate.instrumentId)
        .reverse().sort((a, b) => dateDay(b.tradeDate) - dateDay(a.tradeDate))[0];
      const cooldown = cooldownDecision(result, lastTrade, side, asOfDate, parameters);
      record.decisionContext.cooldown = cooldown;
      if (cooldown.blocked) reasons.push(`Cooldown de ${parameters.cooldown.days} jours : signal inchangé.`);
      else if (candidate.executionReady !== true || !Number.isFinite(candidate.priceEur) || candidate.priceEur <= 0
        || !Number.isFinite(candidate.feesEur) || candidate.feesEur < 0
        || (position && Math.abs(position.marketValueEur - position.quantity * candidate.priceEur) > 0.01)) {
        reasons.push('Prix, FX, frais ou conditions de simulation non validés.');
      } else {
        const availablePosition = plannedPortfolio.positions.find(item => item.instrumentId === candidate.instrumentId);
        const feesCents = Math.ceil(candidate.feesEur * 100 - 1e-8);
        const totalAfterFees = Math.floor(plannedPortfolio.totalValueEur * 100 + 1e-8) - feesCents;
        const headroom = Math.floor(totalAfterFees * parameters.limits.maxPositionWeight + 1e-8)
          - Math.ceil((availablePosition?.marketValueEur ?? 0) * 100 - 1e-8);
        const budgetCents = side === 'SELL' ? Math.floor(position.marketValueEur * 100 + 1e-8)
          : Math.min(headroom,
            Math.floor(plannedPortfolio.cashEur * 100 + 1e-8) - feesCents,
            Math.floor(parameters.limits.maxInvestedCapitalEur * 100)
              - Math.ceil(plannedPortfolio.investedCostEur * 100 - 1e-8) - feesCents,
            Math.floor(parameters.limits.maxInvestedCapitalEur * 100)
              - Math.ceil(plannedPortfolio.positions.reduce((sum, p) => sum + p.marketValueEur, 0) * 100 - 1e-8));
        // Hypothèse explicite : quantités fractionnaires, huit décimales.
        const quantity = side === 'SELL' ? position.quantity
          : Math.floor(Math.max(0, budgetCents) / 100 / candidate.priceEur * 1e8) / 1e8;
        const amountEur = side === 'SELL' ? budgetCents / 100
          : Math.floor(quantity * candidate.priceEur * 100 + 1e-8) / 100;
        const validation = validateProposedTrade(plannedPortfolio, {
          side, instrumentId: candidate.instrumentId, amountEur, feesEur: candidate.feesEur,
        }, usedSlots, parameters.limits);
        if (!validation.allowed) reasons.push(...validation.reasons);
        else {
          record.action = side;
          record.proposedAmountEur = amountEur;
          record.proposedQuantity = quantity;
          record.decisionContext.feesEur = candidate.feesEur;
          reasons.push(side === 'BUY' ? 'Momentum confirmé et score au-dessus du seuil BUY.' : 'Dégradation du score sous le seuil SELL.');
          if (cooldown.exception) reasons.push('Exception au cooldown : changement significatif documenté du signal.');
          usedSlots += 1;
          // Ne pas financer un achat par une vente seulement proposée.
          if (side === 'BUY') {
            const debit = amountEur + feesCents / 100;
            plannedPortfolio.cashEur -= debit;
            plannedPortfolio.investedCostEur += debit;
            plannedPortfolio.totalValueEur -= feesCents / 100;
            if (availablePosition) {
              availablePosition.marketValueEur += amountEur;
              availablePosition.costBasisEur += debit;
              availablePosition.quantity += quantity;
            } else plannedPortfolio.positions.push({ instrumentId: candidate.instrumentId,
              quantity, marketValueEur: amountEur, costBasisEur: debit });
          }
        }
      }
    }
    if (record.action === 'NO_ACTION') {
      noTradeReasons.push(`${record.symbol} : ${reasons.join(' ')}`);
      if (context.includeNoActionAssets) recommendations.push(record);
    }
    else recommendations.push(record);
  }
  if (!recommendations.some(record => ['BUY', 'SELL'].includes(record.action))) {
    recommendations.push({ instrumentId: null, action: 'NO_ACTION', classification: null,
      score: null, confidence: 0, riskLevel: null, horizon: parameters.risk.horizon,
      proposedAmountEur: null, proposedQuantity: null,
      reasons: ['Aucune transaction justifiée ; conservation du cash.', ...noTradeReasons],
      positiveReasons: [], mainRisks: [], review: { ...parameters.review, required: false, triggers: [], automaticSale: false },
      decisionContext: { riskProfile: config.riskProfile, strategy: parameters, rejectedCandidates: noTradeReasons },
    });
  } else if (noTradeReasons.length) {
    // Conserver les refus sans multiplier les NO_ACTION globaux en base.
    recommendations[0].decisionContext.rejectedCandidates = noTradeReasons;
  }
  return recommendations;
}

/** Adapter le contrat existant aux colonnes Supabase de invest_recommendations. */
export function toRecommendationRow(record, runId) {
  return {
    run_id: runId, instrument_id: record.instrumentId, action: record.action,
    score: record.score, reasons: record.reasons,
    proposed_quantity: record.proposedQuantity, estimated_amount_eur: record.proposedAmountEur,
    status: ['BUY', 'SELL'].includes(record.action) ? 'proposed' : 'no_trade',
    classification: record.classification, risk_level: record.riskLevel, confidence: record.confidence,
    positive_reasons: record.positiveReasons, main_risks: record.mainRisks, horizon: record.horizon,
    decision_context: { ...record.decisionContext, review: record.review },
  };
}
