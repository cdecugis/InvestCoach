import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';
import { backfillRange, historicalMetrics, runBackfill30d } from '../src/data/backfill.js';
import { InvestmentRepository } from '../src/db/investmentRepository.js';
import { TABLES } from '../src/db/supabase.js';

const settings = { ...config, dryRun: false };
const now = new Date('2026-10-07T12:00:00Z');
const range = backfillRange(now, settings);
function bars(start = '2025-01-01', end = '2026-10-07', currency = 'EUR') {
  const result = [];
  for (let time = Date.parse(start); time <= Date.parse(end); time += 86400000) {
    const date = new Date(time);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const close = 100 + result.length;
    result.push({ date: date.toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1,
      close, adjustedClose: close, volume: 1000000, isFinal: true, currency });
  }
  return result;
}
const instrument = (symbol, currency = 'EUR') => ({ symbol, providerSymbol: `${symbol}.PA`, exchange: 'XPAR',
  currency, region: 'EU', enabled: true });
function fixture() {
  const universe = { baseCurrency: 'EUR', instruments: [instrument('GOOD'), instrument('BAD'), instrument('NEXT', 'USD'),
    { ...instrument('DISABLED'), enabled: false }],
    benchmark: { name: 'MSCI World (proxy IWDA.AS)', providerSymbol: 'IWDA.AS', returnType: 'net_total_return', currency: 'EUR' } };
  const stores = new Map(), calls = [];
  const repository = new InvestmentRepository({ from(table) {
    assert.ok([TABLES.marketPrices, TABLES.dailyMetrics, TABLES.benchmarkPrices, TABLES.fxRates].includes(table), `écriture interdite : ${table}`);
    return { async upsert(rows, { onConflict }) {
      calls.push({ table, rows: structuredClone(rows), onConflict });
      const store = stores.get(table) ?? new Map();
      for (const row of rows) {
        const values = onConflict.split(',').map(key => key === 'asset_id' ? row.instrument_id : key === 'date' ? row.price_date : row[key]);
        store.set(JSON.stringify(values), structuredClone(row));
      }
      stores.set(table, store);
      return { error: null };
    } };
  } });
  repository.getAssets = async () => universe.instruments.map(asset => ({ ...asset, id: asset.symbol }));
  repository.syncBenchmark = async () => ({ id: 'benchmark' });
  repository.syncAsset = async () => assert.fail('actifs déjà enregistrés');
  const provider = { source: 'yahoo', correction: 0,
    async getAssetMetadata() { return { currency: 'EUR' }; },
    async getDailyHistory(symbol, start, end) {
      assert.equal(start, range.warmupStart);
      assert.equal(end, range.end);
      if (symbol === 'BAD.PA') throw new Error('SYMBOL_NOT_FOUND');
      const rows = bars('2025-01-01', '2026-10-07', symbol === 'NEXT.PA' ? 'USD' : 'EUR');
      const corrected = { ...rows.at(-2), close: rows.at(-2).close + this.correction };
      return [...rows, corrected, { ...rows.at(-2), date: '2026-10-06', isFinal: false }];
    },
    async getFxHistory(currency) {
      assert.equal(currency, 'USD');
      return bars().map(row => ({ date: row.date, currency, eurPerUnit: .9, openEurPerUnit: .91, source: 'yahoo' }));
    } };
  return { universe, stores, calls, repository, provider, settings, now, log() {} };
}

test('fenêtre : 30 jours calendaires terminés, timezone, passage année et warm-up', () => {
  assert.equal(range.start, '2026-09-07');
  assert.equal(range.end, '2026-10-06');
  assert.equal((Date.parse(range.end) - Date.parse(range.start)) / 86400000 + 1, 30);
  assert.ok((Date.parse(range.start) - Date.parse(range.warmupStart)) / 86400000 >= 400);
  const january = backfillRange(new Date('2026-12-31T23:30:00Z'), settings);
  assert.equal(january.end, '2026-12-31');
  assert.equal(january.start, '2026-12-02');
});

test('upserts idempotents et corrigés, symbole défaillant isolé et aucune écriture métier', async () => {
  const options = fixture();
  const result = await runBackfill30d(options);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].symbol, 'BAD.PA');
  assert.deepEqual(result.results.map(row => row.symbol), ['IWDA.AS', 'FX:USD/EUR', 'GOOD.PA', 'BAD.PA', 'NEXT.PA']);
  const prices = options.stores.get(TABLES.marketPrices);
  const before = prices.size;
  assert.ok(before > 0);
  assert.ok([...prices.values()].some(row => row.instrument_id === 'NEXT'));
  assert.ok([...prices.values()].every(row => row.price_date >= range.start && row.price_date <= range.end && row.is_final));
  assert.ok(options.calls.filter(call => call.table === TABLES.marketPrices).every(call => call.onConflict === 'asset_id,date'));
  assert.equal(result.results.find(row => row.symbol === 'GOOD.PA').retrieved, before / 2);
  options.provider.correction = 5;
  await runBackfill30d(options);
  assert.equal(prices.size, before);
  const corrected = [...prices.values()].find(row => row.instrument_id === 'GOOD' && row.price_date === '2026-10-06');
  assert.equal(corrected.close, bars().find(row => row.date === '2026-10-06').close + 5);
  assert.ok(options.calls.filter(call => call.table === TABLES.dailyMetrics).every(call =>
    call.onConflict === 'instrument_id,as_of_date' && call.rows.every(row => row.as_of_date >= range.start && row.as_of_date <= range.end)));
});

test('aucun look-ahead : prix, volumes, FX et benchmark futurs ne changent pas les métriques à D', () => {
  const history = bars(), benchmark = bars();
  const fx = history.map(row => ({ date: row.date, currency: 'USD', eurPerUnit: .9 }));
  const date = '2026-09-15';
  const calculate = (h, b, f) => historicalMetrics(h, 'USD', b, 'USD', f, { start: date, end: date }, settings)[0].metrics;
  const expected = calculate(history, benchmark, fx);
  const changed = rows => rows.map(row => row.date > date ? { ...row, close: 100000, adjustedClose: 99999, volume: 99999999 } : row);
  assert.deepEqual(calculate(changed(history), changed(benchmark), fx.map(row => row.date > date ? { ...row, eurPerUnit: 1000 } : row)), expected);
  assert.deepEqual(calculate(history.filter(row => row.date <= date), benchmark.filter(row => row.date <= date), fx.filter(row => row.date <= date)), expected);
  assert.ok(Number.isFinite(expected.ma200));
  assert.equal(expected.lastPriceDate, date);
  const onlyFutureFx = calculate(history, benchmark, [{ date: '2026-09-16', currency: 'USD', eurPerUnit: .9 }]);
  assert.equal(onlyFutureFx.return1mEur, null);
  assert.equal(onlyFutureFx.marketReturn1m, null);
  assert.equal(onlyFutureFx.liquidityRisk, null);
});

test('ajustements postérieurs : rebasage à D, jamais à la dernière clôture de toute la série', () => {
  const history = bars();
  const date = '2026-09-15';
  const calculate = rows => historicalMetrics(rows, 'EUR', [], 'EUR', [], { start: date, end: date }, settings)[0].metrics;
  const original = calculate(history);
  const splitLater = calculate(history.map(row => ({ ...row, adjustedClose: row.adjustedClose * .5 })));
  assert.deepEqual(splitLater, original);
});

test('historique insuffisant : indicateurs longs null, dates disponibles uniquement', () => {
  const history = bars('2026-10-01', '2026-10-06');
  const results = historicalMetrics(history, 'EUR', [], 'EUR', [], range, settings);
  assert.equal(results.length, history.length);
  for (const { metrics } of results) {
    for (const key of ['sma20', 'sma50', 'ma200', 'rsi14', 'volatility30', 'return12m']) assert.equal(metrics[key], null);
    assert.equal(metrics.dataFresh, false);
  }
});

test('DRY_RUN : télécharge et calcule, aucun upsert ni synchronisation benchmark', async () => {
  const options = fixture();
  options.dryRun = true;
  options.repository.syncBenchmark = () => assert.fail('aucune écriture');
  const result = await runBackfill30d(options);
  assert.equal(options.calls.length, 0);
  assert.ok(result.results.some(row => row.metricsCalculated > 0));
  assert.ok(result.results.every(row => row.upserted === 0));
});

test('backfill partiel : benchmark et FX indisponibles ne bloquent pas les métriques natives', async () => {
  const options = fixture();
  options.provider.getAssetMetadata = async () => { throw new Error('BENCHMARK_UNAVAILABLE'); };
  options.provider.getFxHistory = async () => { throw new Error('FX_UNAVAILABLE'); };
  const result = await runBackfill30d(options);
  assert.equal(result.errors.length, 3);
  const metrics = [...options.stores.get(TABLES.dailyMetrics).values()].filter(row => row.instrument_id === 'NEXT');
  assert.ok(metrics.length > 0);
  assert.ok(metrics.every(row => row.signal_features.return1mEur === null && row.signal_features.marketReturn1m === null));
  assert.ok(metrics.every(row => Number.isFinite(row.ma200)));
});
