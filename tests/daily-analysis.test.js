import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIndicators, movingAverage, wilderRsi, annualizedVolatility, calendarReturn } from '../src/modules/indicators/index.js';
import { runDailyAnalysis } from '../src/jobs/dailyAnalysis.js';
import { config } from '../src/config/env.js';
import { YahooProvider } from '../src/data/providers/yahoo.js';
import { calculatePerformance } from '../src/modules/performance/index.js';
import { InvestmentRepository } from '../src/db/investmentRepository.js';

function bars(length = 400, endDate = '2026-10-05') {
  const dates = [];
  const day = new Date(`${endDate}T12:00:00Z`);
  while (dates.length < length) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return dates.map((date, index) => ({ date, open: 100 + index, high: 101 + index, low: 99 + index,
    close: 100 + index, adjustedClose: 100 + index, volume: 2000000, currency: 'EUR', isFinal: true }));
}

test('RSI Wilder : hausse, baisse, stabilité et référence numérique', () => {
  assert.equal(wilderRsi(Array.from({ length: 15 }, (_, i) => i + 1)), 100);
  assert.equal(wilderRsi(Array.from({ length: 15 }, (_, i) => 15 - i)), 0);
  assert.equal(wilderRsi(Array(15).fill(10)), 50);
  assert.equal(wilderRsi(Array(14).fill(10)), null);
  const reference = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28];
  assert.ok(Math.abs(wilderRsi(reference) - 70.4641) < 0.001);
});

test('MA20, MA50, MA200 et indicateurs manquants', () => {
  const history = bars();
  const metrics = calculateIndicators(history);
  assert.equal(metrics.sma20, 489.5);
  assert.equal(metrics.sma50, 474.5);
  assert.equal(metrics.ma200, 399.5);
  assert.equal(movingAverage([1, 2], 3), null);
  assert.equal(calculateIndicators(bars(199)).ma200, null);
  assert.equal(calculateIndicators(bars(10)).rsi14, null);
  assert.equal(calculateIndicators(bars(10)).volatility20, null);
  assert.equal(calculateIndicators(bars(100)).return12m, null);
  assert.equal(calculateIndicators(bars(252)).distance52wHigh, null);
});

test('rendements 5j, mois calendaires et bornes fin de mois', () => {
  const history = bars();
  assert.equal(calculateIndicators(history).return5d, 499 / 494 - 1);
  for (const months of [1, 3, 6, 12]) assert.ok(Number.isFinite(calendarReturn(history, months)));
  assert.ok(Math.abs(calendarReturn([{date:'2026-02-27',adjustedClose:100},{date:'2026-03-31',adjustedClose:120}], 1) - 0.2) < 1e-12);
});

test('volatilité échantillonnale annualisée et 52 semaines', () => {
  assert.equal(annualizedVolatility(Array(21).fill(100), 20), 0);
  const values = [100, 110, 99];
  const a = Math.log(1.1), b = Math.log(0.9);
  const expected = Math.sqrt((a - b) ** 2 / 2) * Math.sqrt(252);
  assert.ok(Math.abs(annualizedVolatility(values, 2) - expected) < 1e-12);
  const metrics = calculateIndicators(bars());
  assert.ok(metrics.drawdown52w <= 0);
  assert.equal(metrics.distance52wHigh, 0);
  assert.equal(metrics.volumeRatio20, 1);
});

test('historique non valide : doublons, bougie incomplète, ajustements manquants', () => {
  const history = bars(30);
  assert.throws(() => calculateIndicators([...history, history[0]]));
  assert.throws(() => calculateIndicators([{ ...history[0], isFinal: false }]));
  const missing = calculateIndicators(history.map(row => ({ ...row, adjustedClose: null })));
  assert.equal(missing.sma20, null);
  assert.equal(missing.historyComplete, false);
});

function fixture() {
  const universe = { baseCurrency: 'EUR', instruments: [{ symbol: 'TEST', providerSymbol: 'TEST.PA', exchange: 'XPAR',
    currency: 'EUR', region: 'EU', enabled: true }], benchmark: { name:'MSCI World (proxy IWDA.AS)',
    providerSymbol:'IWDA.AS', kind:'etf_proxy', returnType:'net_total_return', currency:'EUR' } };
  const history = bars();
  const provider = { source: 'fixture', async getAssetMetadata(symbol) { return { name: symbol, currency:'EUR' }; },
    async getDailyHistory() { return history; }, async getFxHistory() { throw new Error('EUR ne requiert pas de requête FX'); } };
  const repository = {
    async getPortfolio() { return { id:'portfolio',trading_mode:'paper',initial_capital_eur:1000,cash_eur:1000,
      invested_cost_eur:0,benchmark_base_level_eur:null,benchmark_id:'benchmark' }; },
    async getAssets() { return [{id:'asset',symbol:'TEST',exchange:'XPAR',currency:'EUR',provider_symbol:'TEST.PA'}]; },
    async getPositions() { return []; }, async getTransactions() { return []; }, async getPreviousSnapshot() { return null; },
  };
  return { universe, provider, repository, now:new Date('2026-10-06T21:30:00Z'), settings:config };
}

test('pipeline DRY_RUN : analyses et logs complets, zéro écriture en base', async () => {
  const input = fixture();
  const logs = [];
  for (const method of ['acquire','configurePortfolio','syncAsset','syncBenchmark','savePrices','saveFx',
    'saveBenchmarkPrices','saveMetrics','saveScores','saveRecommendations','executeTrade','finish','rejectOrder']) {
    input.repository[method] = () => { throw new Error(`Écriture interdite : ${method}`); };
  }
  const report = await runDailyAnalysis({ ...input, dryRun:true, log: line => logs.push(line) });
  assert.equal(report.dryRun,true);
  assert.equal(report.portfolio.cashEur,1000);
  assert.equal(report.executedTransactions.length,0);
  assert.ok(report.recommendations.some(row => row.instrumentId==='asset'));
  for (const stage of ['MARKET','INDICATORS','SCORING','PORTFOLIO','TRADES','PERFORMANCE']) {
    assert.ok(logs.some(line => line.startsWith(`[${stage}]`)));
  }
  assert.equal(logs[0], '[DAILY] start');
  for (const stage of ['MARKET','INDICATORS','SCORING','PORTFOLIO','PERFORMANCE']) {
    assert.ok(logs.includes(`[${stage}] start`));
    assert.ok(logs.includes(`[${stage}] done`));
  }
});

test('job déjà terminé : pas de téléchargement ni de nouvelle transaction', async () => {
  const input = fixture();
  input.repository.acquire = async () => ({id:'run',status:'completed'});
  input.provider.getDailyHistory = () => { throw new Error('Ne doit pas télécharger'); };
  const report = await runDailyAnalysis({ ...input,dryRun:false,log:()=>{} });
  assert.equal(report.status,'already_completed');
});

test('pipeline paper complet : persistance cours, métriques, scores, décisions et snapshot sans broker', async () => {
  const input = fixture();
  const writes = [];
  input.repository.acquire = async () => ({id:'run',status:'running',leaseToken:'token'});
  input.repository.configurePortfolio = async () => writes.push('configuration');
  input.repository.heartbeat = async () => {};
  input.repository.syncAsset = async row => ({...row,id:'asset'});
  input.repository.syncBenchmark = async row => ({...row,id:'benchmark'});
  for (const name of ['savePrices','saveFx','saveBenchmarkPrices','saveMetrics','saveScores','saveRecommendations']) {
    input.repository[name] = async rows => {
      writes.push(name);
      if (name==='savePrices') assert.equal(rows.length,400);
      if (name==='saveMetrics') { assert.equal(rows.length,1);assert.ok(rows[0].ma200); }
      if (name==='saveScores') assert.equal(rows[0].signal_context.missing.length,3);
    };
  }
  input.repository.getPendingOrders = async () => [];
  input.repository.finish = async (run,snapshot) => {
    writes.push('snapshot');assert.equal(run.id,'run');assert.equal(snapshot.cash_eur,1000);
  };
  const report=await runDailyAnalysis({...input,dryRun:false,log:()=>{}});
  assert.equal(report.status,'completed');
  assert.equal(report.dryRun,false);
  assert.equal(report.executedTransactions.length,0);
  for (const name of ['savePrices','saveMetrics','saveScores','saveRecommendations','snapshot']) assert.ok(writes.includes(name));
});

test('asset en échec : NO_ACTION, mais cours manquant sur une position fait échouer le job', async () => {
  const input=fixture();
  input.provider.getDailyHistory = async symbol => {
    if (symbol==='TEST.PA') throw new Error('fixture unavailable');
    return bars();
  };
  await assert.rejects(runDailyAnalysis({...input,dryRun:true,log:()=>{}}),/Aucun actif exploitable/);
  input.repository.getPositions = async () => [{instrument_id:'asset',quantity:10,cost_basis_eur:100}];
  await assert.rejects(runDailyAnalysis({...input,dryRun:true,log:()=>{}}),/fixture unavailable/);
});

test('performance EUR et benchmark absent explicite', () => {
  const performance = calculatePerformance({totalValueEur:1100,previousValueEur:1000,benchmarkLevelEur:105,benchmarkBaseLevelEur:100});
  assert.ok(Math.abs(performance.cumulativeReturn - 0.1) < 1e-12);
  assert.ok(Math.abs(performance.excessReturn - 0.05) < 1e-12);
  assert.equal(calculatePerformance({totalValueEur:1000}).benchmarkCumulativeReturn,null);
});

test('adaptateur Yahoo : format normalisé, fin de plage inclusive, clôture et FX inversé', async () => {
  let query;
  const settings = { ...config,marketDelayMs:0,marketRetries:1 };
  const provider = new YahooProvider(settings, {
    async chart(symbol, options) {
      query=options;
      return { meta:{currency:'USD',exchangeTimezoneName:'America/New_York',currentTradingPeriod:{regular:{end:new Date('2026-10-06T20:00:00Z')}}},
        quotes:[{date:new Date('2026-10-06T13:30:00Z'),open:1.2,high:1.3,low:1.1,close:1.25,adjclose:1.25,volume:100}],events:{} };
    },
  },()=>new Date('2026-10-06T21:00:00Z'));
  const history = await provider.getDailyHistory('TEST','2026-10-01','2026-10-06');
  assert.equal(history[0].isFinal,true);
  assert.equal(history[0].date,'2026-10-06');
  assert.equal(query.period2.toISOString().slice(0,10),'2026-10-07');
  const fx = await provider.getFxHistory('USD','2026-10-01','2026-10-06');
  assert.equal(fx[0].eurPerUnit,0.8);
  assert.equal(fx[0].openEurPerUnit,1/1.2);
});

test('FX Yahoo : une seule cotation par date, dernière bougie actualisée conservée', async () => {
  const provider = new YahooProvider({ ...config, marketDelayMs: 0, marketRetries: 1 }, {
    async chart() {
      return { meta: { currency: 'USD', exchangeTimezoneName: 'UTC' }, events: {}, quotes: [
        { date: new Date('2026-10-05T00:00:00Z'), open: 1.1, high: 1.3, low: 1, close: 1.2, adjclose: 1.2 },
        { date: new Date('2026-10-06T00:00:00Z'), open: 1.2, high: 1.4, low: 1.1, close: 1.3, adjclose: 1.3 },
        { date: new Date('2026-10-06T20:00:00Z'), open: 1.2, high: 1.4, low: 1.1, close: 1.25, adjclose: 1.25 },
      ] };
    },
  }, () => new Date('2026-10-07T00:00:00Z'));
  const fx = await provider.getFxHistory('USD', '2026-10-01', '2026-10-06');
  assert.equal(fx.length, 2);
  assert.deepEqual(fx.map(row => row.date), ['2026-10-05', '2026-10-06']);
  assert.equal(fx[1].eurPerUnit, .8);
  assert.equal(fx[1].openEurPerUnit, 1/1.2);
});

test('persistance FX : clés date/devise dédupliquées avant upsert, aucune suppression', async () => {
  const calls = [];
  const repository = new InvestmentRepository({ from(table) {
    assert.equal(table, 'invest_fx_rates');
    return { async upsert(rows, options) { calls.push({ rows, options }); return { data: null, error: null }; } };
  } });
  const rows = [
    { rate_date: '2026-10-06', currency: 'USD', eur_per_unit: .79 },
    { rate_date: '2026-10-06', currency: 'GBP', eur_per_unit: 1.16 },
    { rate_date: '2026-10-06', currency: 'USD', eur_per_unit: .8 },
  ];
  const before = structuredClone(rows);
  assert.equal(await repository.saveFx(rows), 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.onConflict, 'rate_date,currency');
  assert.equal(calls[0].rows.find(row => row.currency === 'USD').eur_per_unit, .8);
  assert.equal(calls[0].rows.find(row => row.currency === 'GBP').eur_per_unit, 1.16);
  assert.deepEqual(rows, before);
});
