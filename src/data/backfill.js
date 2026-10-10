import { readFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { InvestmentRepository } from '../db/investmentRepository.js';
import { createMarketDataProvider } from './marketDataProvider.js';
import { calculateIndicators, calendarReturn, toMetricsRow } from '../modules/indicators/index.js';
import { redactLogText } from '../shared/error-log.js';

const dayMs = 86400000;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function backfillRange(now, settings) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: settings.timezone }).format(now);
  const start = shift(today, -30), end = shift(today, -1);
  return { start, end, warmupStart: shift(start, -settings.historyLookbackDays) };
}

function loadWatchlist(settings) {
  const universe = JSON.parse(readFileSync(settings.universePath, 'utf8'));
  if (universe.baseCurrency !== 'EUR' || !Array.isArray(universe.instruments) || !universe.benchmark
    || universe.instruments.some(asset => !asset.symbol || !asset.providerSymbol || !asset.exchange || !asset.currency)) {
    throw new Error('Configuration univers invalide.');
  }
  const symbol = settings.benchmarkSymbol || universe.benchmark.providerSymbol;
  return { ...universe, benchmark: { ...universe.benchmark, providerSymbol: symbol, name: `MSCI World (proxy ${symbol})` } };
}

function finalHistory(rows, start, end) {
  const daily = new Map(rows.filter(row => row.isFinal && row.date >= start && row.date <= end)
    .map(row => [row.date, row]));
  return [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function rateAt(fx, currency, date, maxAge) {
  if (currency === 'EUR') return 1;
  const row = fx.findLast(item => item.currency === currency && item.date <= date);
  return row && (Date.parse(date) - Date.parse(row.date)) / dayMs <= maxAge ? row.eurPerUnit : null;
}

// Yahoo ajuste rétrospectivement les prix. Ancrer à la clôture D élimine
// le facteur multiplicatif des splits/dividendes postérieurs à D.
function asOfHistory(history, date) {
  const prefix = history.filter(row => row.date <= date);
  const last = prefix.at(-1);
  const scale = finite(last?.adjustedClose) && last.adjustedClose > 0 ? last.close / last.adjustedClose : null;
  return prefix.map(row => ({ ...row,
    adjustedClose: scale !== null && finite(row.adjustedClose) ? row.adjustedClose * scale : null }));
}

/** Ne consomme aucune observation asset/FX/benchmark postérieure à D. */
export function historicalMetrics(history, currency, benchmark, benchmarkCurrency, fx, range, settings) {
  return history.filter(row => row.date >= range.start && row.date <= range.end).map(row => {
    const prefix = asOfHistory(history, row.date);
    const convert = (rows, ccy) => rows.map(item => {
      const rate = rateAt(fx, ccy, item.date, settings.maxPriceAgeDays);
      return { ...item, adjustedClose: rate === null || item.adjustedClose === null ? null : item.adjustedClose * rate };
    });
    const comparable = convert(asOfHistory(benchmark, row.date), benchmarkCurrency);
    const eur = convert(prefix, currency);
    const turnover = prefix.slice(-20).map(item => {
      const rate = rateAt(fx, currency, item.date, settings.maxPriceAgeDays);
      return finite(item.volume) && rate !== null ? item.close * item.volume * rate : null;
    });
    const metrics = { ...calculateIndicators(prefix), asOfDate: row.date,
      return1mEur: calendarReturn(eur, 1, row.date), marketReturn1m: calendarReturn(comparable, 1, row.date),
      dataFresh: Boolean(comparable.length && (Date.parse(row.date) - Date.parse(comparable.at(-1).date)) / dayMs <= settings.maxPriceAgeDays),
      liquidityRisk: turnover.length === 20 && turnover.every(finite)
        ? turnover.reduce((sum, value) => sum + value, 0) / 20 < settings.strategy.risk.minAverageTurnoverEur : null,
      sectorReturn1m: null, earnings: null, catalysts: [], eventRisk: null };
    if (metrics.return1mEur === null) metrics.marketReturn1m = null;
    metrics.calculationVersion = 'historical-indicators-v1-asof-rebased';
    return { date: row.date, metrics };
  });
}

/** Pipeline autonome : seules les données de marché et métriques sont écrites. */
export async function runBackfill30d(options = {}) {
  const settings = options.settings ?? config;
  const dryRun = options.dryRun ?? settings.dryRun;
  if (settings.paperTrading !== true || typeof dryRun !== 'boolean') throw new Error('Mode paper/dry-run invalide.');
  const range = backfillRange(options.now ?? new Date(), settings);
  const universe = options.universe ?? loadWatchlist(settings);
  const repository = options.repository ?? new InvestmentRepository();
  const provider = options.provider ?? await createMarketDataProvider(settings);
  const writeLog = options.log ?? console.log;
  const log = value => writeLog(redactLogText(value));
  const results = [], fx = [];
  const report = { ...range, dryRun, results, errors: [] };
  const inWindow = row => row.date >= range.start && row.date <= range.end;
  const record = async (symbol, operation) => {
    const result = { symbol, retrieved: 0, upserted: 0, firstDate: null, lastDate: null, error: null };
    results.push(result);
    try { await operation(result); }
    catch (error) {
      result.error = redactLogText(error.message ?? 'BACKFILL_FAILED');
      report.errors.push({ symbol, message: result.error });
    }
    log(`[BACKFILL] ${symbol} récupérées=${result.retrieved} upsertées=${result.upserted} première=${result.firstDate ?? 'n/a'} dernière=${result.lastDate ?? 'n/a'}${result.error ? ` erreur=${result.error}` : ''}`);
  };
  const describe = (result, rows) => {
    result.retrieved = rows.length;
    result.firstDate = rows[0]?.date ?? null;
    result.lastDate = rows.at(-1)?.date ?? null;
  };
  log(`[BACKFILL] ${range.start} → ${range.end}, warm-up ${range.warmupStart} ; ${dryRun ? 'DRY_RUN, aucune écriture' : 'écriture marché uniquement'}`);
  const instruments = universe.instruments.filter(asset => asset.enabled !== false);
  let benchmarkHistory = [], benchmarkCurrency = universe.benchmark.currency;
  await record(universe.benchmark.providerSymbol, async result => {
    const metadata = await provider.getAssetMetadata(universe.benchmark.providerSymbol);
    benchmarkCurrency = metadata.currency;
    benchmarkHistory = finalHistory(await provider.getDailyHistory(universe.benchmark.providerSymbol, range.warmupStart, range.end), range.warmupStart, range.end);
    if (benchmarkHistory.some(row => row.currency !== benchmarkCurrency)) throw new Error('Devise benchmark incohérente.');
    const rows = benchmarkHistory.filter(inWindow).filter(row => finite(row.adjustedClose) && row.adjustedClose > 0);
    describe(result, rows);
    if (!rows.length) throw new Error('Aucune clôture benchmark disponible.');
    if (!dryRun) {
      const benchmark = await repository.syncBenchmark({ name: universe.benchmark.name, kind: 'etf_proxy',
        return_type: universe.benchmark.returnType, currency: benchmarkCurrency, provider_symbol: universe.benchmark.providerSymbol });
      result.upserted = await repository.saveBenchmarkPrices(rows.map(row => ({ benchmark_id: benchmark.id,
        price_date: row.date, level: row.adjustedClose, source: provider.source })));
    }
  });
  if (results.at(-1).error) benchmarkHistory = [];
  for (const currency of new Set([...instruments.map(asset => asset.currency), benchmarkCurrency].filter(value => value !== 'EUR'))) {
    await record(`FX:${currency}/EUR`, async result => {
      const rows = [...new Map((await provider.getFxHistory(currency, range.warmupStart, range.end))
        .filter(row => row.date >= range.warmupStart && row.date <= range.end && row.currency === currency)
        .map(row => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
      fx.push(...rows);
      const target = rows.filter(inWindow);
      describe(result, target);
      if (!target.length) throw new Error('Aucun taux FX disponible.');
      if (!dryRun) result.upserted = await repository.saveFx(target.map(row => ({ rate_date: row.date, currency,
        eur_per_unit: row.eurPerUnit, open_eur_per_unit: row.openEurPerUnit, source: row.source })));
    });
  }
  fx.sort((a, b) => a.date.localeCompare(b.date));
  const existing = await repository.getAssets();
  for (const instrument of instruments) {
    await record(instrument.providerSymbol, async result => {
      const history = finalHistory(await provider.getDailyHistory(instrument.providerSymbol, range.warmupStart, range.end), range.warmupStart, range.end);
      if (history.some(row => row.currency !== instrument.currency)) throw new Error('Devise des bougies incohérente.');
      const rows = history.filter(inWindow);
      describe(result, rows);
      if (!rows.length) throw new Error('Aucune clôture complète dans la fenêtre.');
      let asset = existing.find(row => row.symbol === instrument.symbol && row.exchange === instrument.exchange);
      if (asset && asset.currency !== instrument.currency) throw new Error('Devise actif existant incohérente.');
      if (!asset && !dryRun) asset = await repository.syncAsset({ symbol: instrument.symbol, exchange: instrument.exchange,
        currency: instrument.currency, region: instrument.region, provider_symbol: instrument.providerSymbol, enabled: true, name: instrument.symbol });
      if (!dryRun) result.upserted = await repository.savePrices(rows.map(row => ({ instrument_id: asset.id, price_date: row.date,
        open: row.open, high: row.high, low: row.low, close: row.close, adjusted_close: row.adjustedClose,
        volume: row.volume, source: provider.source, adjustment_method: 'Yahoo splits/dividends', is_final: true,
        dividend: row.dividend ?? null, split_ratio: row.splitRatio ?? null })));
      const metrics = historicalMetrics(history, instrument.currency, benchmarkHistory, benchmarkCurrency, fx, range, settings);
      result.metricsCalculated = metrics.length;
      result.metricsUpserted = dryRun ? 0 : await repository.saveMetrics(metrics.map(item => toMetricsRow(asset.id, item.date, item.metrics)));
    });
  }
  log(`[BACKFILL] terminé ; erreurs=${report.errors.length}, aucune recommandation/transaction/email/run modifié`);
  return report;
}
