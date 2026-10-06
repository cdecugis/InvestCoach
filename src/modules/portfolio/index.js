import { config } from '../../config/env.js';
import { dateDay } from '../scoring/index.js';

const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const centsDown = value => Math.floor(value * 100 + 1e-8);
const centsUp = value => Math.ceil(value * 100 - 1e-8);

/** Contrôle de proposition ; revalidation atomique obligatoire à l'exécution. */
export function validateProposedTrade(portfolio, trade, tradesToday, limits = config.strategy.limits) {
  const reasons = [];
  if (!Array.isArray(portfolio.positions) || !Number.isInteger(tradesToday) || tradesToday < 0
    || ![portfolio.cashEur, portfolio.investedCostEur, portfolio.totalValueEur].every(money)
    || portfolio.totalValueEur <= 0
    || portfolio.positions.some(position => !money(position.marketValueEur) || !money(position.costBasisEur)
      || !money(position.quantity) || position.quantity <= 0)
    || new Set(portfolio.positions.map(position => position.instrumentId)).size !== portfolio.positions.length) {
    return { allowed: false, reasons: ['État du portefeuille incomplet ou invalide.'] };
  }
  const sumCost = portfolio.positions.reduce((sum, position) => sum + position.costBasisEur, 0);
  const sumValue = portfolio.positions.reduce((sum, position) => sum + position.marketValueEur, 0);
  if (Math.abs(sumCost - portfolio.investedCostEur) > 0.01
    || Math.abs(portfolio.cashEur + sumValue - portfolio.totalValueEur) > 0.01) {
    return { allowed: false, reasons: ['Cash, coûts et valorisation incohérents.'] };
  }
  if (!['BUY', 'SELL'].includes(trade.side) || !money(trade.amountEur) || trade.amountEur <= 0
    || Math.abs(trade.amountEur * 100 - Math.round(trade.amountEur * 100)) > 1e-6
    || !money(trade.feesEur) || typeof trade.instrumentId !== 'string' || !trade.instrumentId) {
    return { allowed: false, reasons: ['Ordre ou frais invalides.'] };
  }
  if (tradesToday >= limits.maxTradesPerDay) reasons.push('Limite de deux transactions quotidiennes atteinte.');
  const amount = Math.round(trade.amountEur * 100);
  const fees = centsUp(trade.feesEur);
  const position = portfolio.positions.find(item => item.instrumentId === trade.instrumentId);
  // Une clôture totale est permise sous 100 EUR pour ne pas laisser de reliquat.
  const fullExit = trade.side === 'SELL' && position && amount === centsDown(position.marketValueEur);
  if (amount < centsUp(limits.minOrderEur) && !fullExit) reasons.push('Ordre inférieur au minimum de 100 EUR.');
  if (trade.side === 'BUY') {
    if (portfolio.positions.length > limits.maxPositions
      || (!position && portfolio.positions.length >= limits.maxPositions)) reasons.push('Maximum de quatre positions atteint.');
    if (amount + fees > centsDown(portfolio.cashEur)) reasons.push('Cash insuffisant, frais inclus.');
    if (centsUp(portfolio.investedCostEur) + amount + fees > centsDown(limits.maxInvestedCapitalEur)) reasons.push('Capital engagé supérieur à 1000 EUR.');
    if (centsUp(sumValue) + amount > centsDown(limits.maxInvestedCapitalEur)) reasons.push('Exposition de marché supérieure à 1000 EUR.');
    const positionAfter = centsUp(position?.marketValueEur ?? 0) + amount;
    const totalAfter = centsDown(portfolio.totalValueEur) - fees;
    if (positionAfter > Math.floor(totalAfter * limits.maxPositionWeight + 1e-8)) reasons.push('Position supérieure à 35 % après achat.');
  } else {
    if (!position || amount > centsDown(position.marketValueEur)) reasons.push('Vente à découvert interdite.');
    if (centsDown(portfolio.cashEur) + amount < fees) reasons.push('Cash insuffisant pour les frais de vente.');
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Valorisation EUR : cash + quantités * cours bruts * taux FX vers EUR.
 * Retourne valeur, cash, capital engagé, poids, P&L et diagnostics de fraîcheur.
 */
export function valuePortfolio(portfolio, prices, fxRates) {
  const positions = portfolio.positions.map(position => {
    const price = prices.get(position.instrumentId);
    if (!price || !money(price.close) || price.close <= 0) throw new Error(`Cours absent pour ${position.instrumentId}.`);
    const fx = position.currency === 'EUR' ? { eurPerUnit: 1, date: price.date }
      : fxRates.findLast(row => row.currency === position.currency && row.date <= price.date);
    if (!fx || !money(fx.eurPerUnit) || fx.eurPerUnit <= 0
      || (dateDay(price.date) - dateDay(fx.date)) / 86400000 > config.maxPriceAgeDays) throw new Error(`FX absent ou ancien pour ${position.currency}.`);
    return { ...position, marketValueEur: Math.round(position.quantity * price.close * fx.eurPerUnit * 1e6) / 1e6,
      priceDate: price.date, fxDate: fx.date };
  });
  const positionsValueEur = Math.round(positions.reduce((sum, position) => sum + position.marketValueEur, 0) * 1e6) / 1e6;
  const totalValueEur = Math.round((portfolio.cashEur + positionsValueEur) * 1e6) / 1e6;
  return { ...portfolio, positionsValueEur, totalValueEur,
    positions: positions.map(position => ({ ...position, weight: totalValueEur > 0 ? position.marketValueEur / totalValueEur : 0 })) };
}

/**
 * Exécution virtuelle seulement, via une future RPC SQL atomique : verrouiller
 * le portefeuille, vérifier cash/limites/décompte journalier puis tout écrire.
 * Les propositions ne sont pas des transactions et ne modifient pas le cash.
 */
export async function executePaperTrades(context) {
  if (!context?.repository || !context.run) throw new Error('Contexte de paper trading incomplet.');
  if (context.dryRun) return [];
  if (context.paperTrading !== true || config.paperTrading !== true) throw new Error('Paper trading obligatoire.');
  const executed = [];
  for (const order of context.orders) {
    if (executed.length >= context.remainingSlots) break;
    const result = await context.repository.executeTrade(context.run, order.id, context.feesEur);
    if (result.status === 'executed') executed.push(result);
  }
  return executed;
}
