import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config/env.js';
import { calculateInvestmentScore } from '../src/modules/scoring/index.js';
import { validateProposedTrade, executePaperTrades } from '../src/modules/portfolio/index.js';
import { generateRecommendations, reviewPosition, toRecommendationRow } from '../src/modules/recommendations/index.js';
import { renderDailyEmail, sendDailyEmail } from '../src/modules/email/index.js';
import { runDailyJob } from '../src/jobs/daily-job.js';

const parameters = JSON.parse(readFileSync(new URL('../config/strategy.json', import.meta.url), 'utf8')).AGGRESSIVE;
const asOfDate = '2026-10-06';
const strong = overrides => ({
  asOfDate, historyComplete: true, dataFresh: true,
  return1m: 0.20, return3m: 0.40, return5d: 0.12, previousReturn5d: 0.02,
  volumeRatio20: 2.5, distanceToHigh60: 0.02, marketReturn1m: 0.05, sectorReturn1m: 0.05,
  volatility30: 0.7, liquidityRisk: false, eventRisk: false,
  earnings: { date: '2026-10-05', surprisePct: 0.20, source: 'company-results' },
  catalysts: [{ type: 'guidance_raise', strength: 1, date: '2026-10-05', source: 'company-release', description: 'Guidance relevée' }],
  ...overrides,
});
const weak = () => strong({ return1m: -0.1, return3m: -0.2, return5d: -0.1, previousReturn5d: 0,
  distanceToHigh60: -0.15, marketReturn1m: 0, sectorReturn1m: 0,
  earnings: { date: '2026-10-05', surprisePct: -0.1, source: 'company-results' },
  catalysts: [{ type: 'guidance_cut', strength: -1, date: '2026-10-05', source: 'company-release', description: 'Guidance réduite' }],
});
const candidate = (instrumentId = 'A', indicators = strong()) => ({ instrumentId, symbol: instrumentId,
  indicators, priceEur: 10, feesEur: 0, executionReady: true });
const empty = () => ({ cashEur: 1000, investedCostEur: 0, totalValueEur: 1000, positions: [] });
const invested = (marketValueEur = 300) => ({ cashEur: 700, investedCostEur: 300,
  totalValueEur: 700 + marketValueEur,
  positions: [{ instrumentId: 'A', quantity: 30, costBasisEur: 300, marketValueEur }] });
const context = overrides => ({ asOfDate, portfolio: empty(), candidates: [candidate()], tradeHistory: [], ...overrides });
const propose = value => generateRecommendations(value, parameters);

test('configuration centralisée : 100 %, plafonds et paper trading', () => {
  assert.equal(Object.values(parameters.weights).reduce((sum, value) => sum + value, 0), 100);
  assert.equal(config.tradingMode, 'paper');
  assert.equal(config.maxPositionWeight, 0.35);
  assert.equal(config.maxPositions, 4);
  assert.equal(config.maxTradesPerDay, 2);
  assert.equal(config.initialCapitalEur, 1000);
});

test('score borné, traçable ; volatilité et valorisation ne retirent pas de points', () => {
  const highRisk = calculateInvestmentScore(strong({ peRatio: 150, dividendYield: 0 }), parameters);
  const lowerRisk = calculateInvestmentScore(strong({ volatility30: 0.2 }), parameters);
  assert.equal(highRisk.score, 100);
  assert.equal(lowerRisk.score, highRisk.score);
  assert.equal(highRisk.classification, 'SPECULATIVE');
  assert.equal(lowerRisk.classification, 'CORE');
  assert.equal(highRisk.components.momentum1m.contribution, 20);
  assert.equal(calculateInvestmentScore(weak(), parameters).score, 0);
});

test('les données absentes ne sont pas renormalisées et bloquent les achats techniques incomplets', () => {
  const incomplete = calculateInvestmentScore(strong({ volumeRatio20: null }), parameters);
  assert.equal(incomplete.score, null);
  assert.equal(incomplete.confidence, 0);
  const withoutNews = calculateInvestmentScore(strong({ catalysts: [], earnings: undefined }), parameters);
  assert.equal(withoutNews.score, 85);
  assert.equal(withoutNews.confidence, 0.85);
  assert.ok(withoutNews.missing.includes('catalysts'));
});

test('news anciennes, futures, non sourcées et doublons ne gonflent pas le score', () => {
  const evidence = strong().catalysts[0];
  for (const change of [{ date: '2026-08-01' }, { date: '2026-10-07' }, { source: '' }, { date: '2026-02-30' }]) {
    const result = calculateInvestmentScore(strong({ catalysts: [{ ...evidence, ...change }] }), parameters);
    assert.equal(result.components.catalysts.score, null);
  }
  assert.equal(calculateInvestmentScore(strong({ catalysts: [evidence, evidence] }), parameters).score, 100);
});

test('volumes élevés dans une baisse ne constituent pas une confirmation haussière', () => {
  assert.equal(calculateInvestmentScore(strong({ return5d: -0.05 }), parameters).components.unusualVolume.score, 0);
});

test('pas d’achat pour consommer le cash et pas de diversification obligatoire', () => {
  assert.equal(propose(context({ candidates: [candidate('A', weak())] }))[0].action, 'NO_ACTION');
  const records = propose(context());
  assert.equal(records.length, 1);
  assert.equal(records[0].action, 'BUY');
  assert.equal(records[0].proposedAmountEur, 350);
  assert.equal(records[0].classification, 'SPECULATIVE');
});

test('réservation des propositions : deux transactions maximum, même avec six bons signaux', () => {
  const records = propose(context({ candidates: ['A', 'B', 'C', 'D', 'E', 'F'].map(id => candidate(id)) }));
  assert.equal(records.filter(record => record.action === 'BUY').length, 2);
  assert.equal(records.reduce((sum, record) => sum + (record.proposedAmountEur ?? 0), 0), 700);
  assert.ok(records[0].decisionContext.rejectedCandidates.length >= 4);
});

test('limite quotidienne tient compte des transactions déjà exécutées', () => {
  const tradeHistory = ['X', 'Y'].map(instrumentId => ({ instrumentId, tradeDate: asOfDate, side: 'BUY', scoreAtTrade: 80 }));
  assert.equal(propose(context({ tradeHistory })).at(-1).action, 'NO_ACTION');
});

test('35 %, quatre positions, minimum 100 EUR, frais et coût engagé sont contrôlés', () => {
  const trade = { side: 'BUY', instrumentId: 'A', amountEur: 350, feesEur: 0 };
  assert.equal(validateProposedTrade(empty(), trade, 0).allowed, true);
  assert.equal(validateProposedTrade(empty(), { ...trade, amountEur: 350.01 }, 0).allowed, false);
  assert.equal(validateProposedTrade(empty(), { ...trade, feesEur: 1 }, 0).allowed, false);
  assert.equal(validateProposedTrade(empty(), { ...trade, amountEur: 99.99 }, 0).allowed, false);
  const portfolio = { cashEur: 200, investedCostEur: 800, totalValueEur: 1000,
    positions: ['A', 'B', 'C', 'D'].map(instrumentId => ({ instrumentId, quantity: 20, marketValueEur: 200, costBasisEur: 200 })) };
  assert.equal(validateProposedTrade(portfolio, { ...trade, instrumentId: 'E', amountEur: 100 }, 0).allowed, false);
  assert.equal(validateProposedTrade(portfolio, { ...trade, amountEur: 100 }, 0).allowed, true);
  const inconsistent = { ...empty(), investedCostEur: 900 };
  assert.equal(validateProposedTrade(inconsistent, trade, 0).allowed, false);
});

test('100 % du capital est permis sans imposer une réserve de cash', () => {
  const portfolio = { cashEur: 100, investedCostEur: 900, totalValueEur: 1000,
    positions: ['A', 'B', 'C'].map(instrumentId => ({ instrumentId, quantity: 30, marketValueEur: 300, costBasisEur: 300 })) };
  const result = propose(context({ portfolio, candidates: [candidate('D')] }));
  assert.equal(result.find(record => record.instrumentId === 'D').proposedAmountEur, 100);
  assert.equal(validateProposedTrade(portfolio, { side: 'BUY', instrumentId: 'D', amountEur: 100, feesEur: 0 }, 0).allowed, true);
});

test('seuils −18/+25 % : réanalyse avec HOLD si le signal reste neutre', () => {
  for (const value of [246, 375]) {
    const portfolio = invested(value);
    const indicators = strong({ return1m: 0.1, return3m: 0.2, return5d: 0.02,
      previousReturn5d: 0.02, volumeRatio20: 1, distanceToHigh60: -0.05,
      catalysts: [], earnings: undefined });
    const item = { ...candidate('A', indicators), priceEur: value / 30 };
    const held = propose(context({ portfolio, candidates: [item] })).find(record => record.instrumentId === 'A');
    assert.equal(held.action, 'HOLD');
    assert.equal(held.review.required, true);
    assert.equal(held.review.automaticSale, false);
  }
  assert.equal(reviewPosition(invested(246).positions[0], parameters).triggers[0], 'STOP_REVIEW');
});

test('cooldown bloque un aller-retour sauf dégradation significative', () => {
  const tradeHistory = [{ instrumentId: 'A', tradeDate: '2026-10-04', side: 'BUY', scoreAtTrade: 10 }];
  const weakSignal = weak();
  weakSignal.catalysts[0].date = '2026-10-03';
  const unchanged = propose(context({ portfolio: invested(), candidates: [candidate('A', weakSignal)], tradeHistory }));
  assert.equal(unchanged.find(record => record.instrumentId === 'A').action, 'HOLD');
  const changed = propose(context({ portfolio: invested(), candidates: [candidate('A', weak())],
    tradeHistory: [{ ...tradeHistory[0], scoreAtTrade: 90 }] }));
  assert.equal(changed.find(record => record.instrumentId === 'A').action, 'SELL');
});

test('réachat récent interdit sans nouvelle preuve, autorisé avec un catalyseur significatif nouveau', () => {
  const tradeHistory = [{ instrumentId: 'A', tradeDate: '2026-10-04', side: 'SELL', scoreAtTrade: 100 }];
  const oldNews = strong({ catalysts: [{ ...strong().catalysts[0], date: '2026-10-03' }] });
  assert.equal(propose(context({ candidates: [candidate('A', oldNews)], tradeHistory }))[0].action, 'NO_ACTION');
  assert.equal(propose(context({ tradeHistory }))[0].action, 'BUY');
});

test('historique absent, futur ou candidat dupliqué refusé ; signal daté ancien non exploité', () => {
  assert.throws(() => propose(context({ tradeHistory: undefined })));
  assert.throws(() => propose(context({ tradeHistory: [{ instrumentId: 'A', side: 'BUY', tradeDate: '2026-10-07' }] })));
  assert.throws(() => propose(context({ candidates: [candidate(), candidate()] })));
  assert.equal(propose(context({ candidates: [candidate('A', strong({ asOfDate: '2026-10-05' }))] }))[0].action, 'NO_ACTION');
});

test('vente sous 100 EUR permise uniquement pour clôturer un reliquat', () => {
  const portfolio = { cashEur: 950, investedCostEur: 50, totalValueEur: 1000,
    positions: [{ instrumentId: 'A', quantity: 5, costBasisEur: 50, marketValueEur: 50 }] };
  assert.equal(validateProposedTrade(portfolio, { side: 'SELL', instrumentId: 'A', amountEur: 50, feesEur: 0 }, 0).allowed, true);
  assert.equal(validateProposedTrade(portfolio, { side: 'SELL', instrumentId: 'A', amountEur: 40, feesEur: 0 }, 0).allowed, false);
  assert.equal(validateProposedTrade(portfolio, { side: 'SELL', instrumentId: 'A', amountEur: 100, feesEur: 0 }, 0).allowed, false);
});

test('email affiche le risque, la confiance, les réanalyses et échappe les sources', () => {
  const record = propose(context())[0];
  record.symbol = '<script>alert(1)</script>';
  const message = renderDailyEmail({ date: asOfDate, totalValueEur: 1000, cashEur: 1000,
    cumulativeReturn: 0, positions: [], recommendations: [record] });
  for (const text of ['BUY', 'SPECULATIVE', 'TRÈS ÉLEVÉ', 'confiance', 'Principaux risques', '-18', '+25', 'aucune vente automatique']) {
    assert.ok(message.html.includes(text));
    assert.ok(message.text.includes(text));
  }
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.ok(!message.html.includes('<script>'));
  const row = toRecommendationRow(record, 'run-id');
  assert.equal(row.classification, 'SPECULATIVE');
  assert.equal(row.estimated_amount_eur, 350);
  assert.equal(row.decision_context.review.automaticSale, false);
});

test('email désactivé, exécution sans contexte refusée et DRY_RUN sans transaction', async () => {
  assert.deepEqual(await sendDailyEmail({}, { enabled: false }), { sent: false });
  await assert.rejects(executePaperTrades({}), /incomplet/);
  assert.deepEqual(await executePaperTrades({ repository: { executeTrade() { throw new Error('écriture interdite'); } },
    run: { id: 'run' }, dryRun: true }), []);
});

test('BUY et SELL partagent les deux emplacements ; une vente proposée ne finance aucun achat', () => {
  const portfolio = { cashEur: 50, investedCostEur: 300, totalValueEur: 350,
    positions: [{ instrumentId: 'A', quantity: 30, costBasisEur: 300, marketValueEur: 300 }] };
  const records = propose(context({ portfolio, candidates: [candidate('A', weak()), candidate('B')] }));
  assert.equal(records.filter(record => record.action === 'SELL').length, 1);
  assert.equal(records.filter(record => record.action === 'BUY').length, 0);
  const mixed = propose(context({ portfolio: invested(), candidates: [candidate('A', weak()), candidate('B'), candidate('C')] }));
  assert.equal(mixed.filter(record => ['BUY', 'SELL'].includes(record.action)).length, 2);
  assert.equal(mixed.filter(record => record.action === 'SELL').length, 1);
});

test('catalyseurs contradictoires : égalité défavorable déterministe, données malformées ignorées', () => {
  const positive = strong().catalysts[0];
  const negative = { ...positive, type: 'guidance_cut', strength: -1 };
  for (const catalysts of [[positive, negative], [negative, positive]]) {
    assert.equal(calculateInvestmentScore(strong({ catalysts }), parameters).components.catalysts.score, 0);
  }
  for (const catalysts of [null, 'invalid', [null]]) {
    assert.equal(calculateInvestmentScore(strong({ catalysts }), parameters).components.catalysts.score, null);
  }
});

test('configuration refuse modes réels, profil inconnu et seuils incohérents', async () => {
  let sequence = 0;
  for (const [key, value] of [['TRADING_MODE', 'live'], ['RISK_PROFILE', 'UNKNOWN'],
    ['STOP_REVIEW_PCT', '18'], ['TAKE_PROFIT_REVIEW_PCT', '-25'], ['COOLDOWN_DAYS', '0']]) {
    const previous = process.env[key];
    try {
      process.env[key] = value;
      await assert.rejects(import(`../src/config/env.js?invalid=${sequence++}`));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
  const previous = process.env.TRADING_MODE;
  try {
    process.env.TRADING_MODE = 'PAPER_TRADING';
    assert.equal((await import('../src/config/env.js?paper-alias')).config.tradingMode, 'paper');
  } finally {
    if (previous === undefined) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = previous;
  }
});
