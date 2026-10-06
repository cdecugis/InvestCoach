import { readFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { InvestmentRepository } from '../db/investmentRepository.js';
import { createMarketDataProvider } from '../data/marketDataProvider.js';
import { calculateIndicators, calendarReturn, toMetricsRow } from '../modules/indicators/index.js';
import { calculateInvestmentScore, dateDay } from '../modules/scoring/index.js';
import { generateRecommendations, toRecommendationRow } from '../modules/recommendations/index.js';
import { executePaperTrades, valuePortfolio } from '../modules/portfolio/index.js';
import { calculatePerformance } from '../modules/performance/index.js';
import { redactLogText } from '../shared/error-log.js';

const isoDate = (now, timezone) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(now);
const age = (newer, older) => (dateDay(newer) - dateDay(older)) / 86400000;
const numeric = value => value === null || value === undefined ? null : Number(value);

export function loadUniverse(settings) {
  const universe = JSON.parse(readFileSync(settings.universePath, 'utf8'));
  if (universe.baseCurrency !== 'EUR' || !Array.isArray(universe.instruments) || universe.instruments.length > 50
    || universe.instruments.some(asset => !asset.symbol || !asset.providerSymbol || !asset.exchange
      || !['US', 'EU'].includes(asset.region) || !/^[A-Z]{3}$/.test(asset.currency))
    || new Set(universe.instruments.map(asset => `${asset.symbol}@${asset.exchange}`)).size !== universe.instruments.length) {
    throw new Error('Configuration univers invalide (50 actifs maximum).');
  }
  const symbol = settings.benchmarkSymbol || universe.benchmark.providerSymbol;
  return { ...universe, benchmark: { ...universe.benchmark, providerSymbol: symbol,
    name: `MSCI World (proxy ${symbol})`, kind: 'etf_proxy' } };
}

function portfolioInput(row, positions, assets) {
  return { id: row.id, cashEur: Number(row.cash_eur), investedCostEur: Number(row.invested_cost_eur),
    positions: positions.map(position => {
      const asset = assets.find(item => item.id === position.instrument_id);
      if (!asset) throw new Error('Actif d’une position introuvable.');
      return { instrumentId: asset.id, symbol: asset.provider_symbol ?? asset.symbol,
        currency: asset.currency, quantity: Number(position.quantity), costBasisEur: Number(position.cost_basis_eur) };
    }) };
}

function fxAt(fx, currency, date, maxAge) {
  if (currency === 'EUR') return 1;
  const row = fx.findLast(item => item.currency === currency && item.date <= date);
  if (!row || age(date, row.date) > maxAge) return null;
  return row.eurPerUnit;
}

function eurHistory(history, currency, fx, settings) {
  return history.map(row => ({ ...row, adjustedClose: row.adjustedClose === null ? null
    : (fxAt(fx, currency, row.date, settings.maxPriceAgeDays) === null ? null
      : row.adjustedClose * fxAt(fx, currency, row.date, settings.maxPriceAgeDays)) }));
}

function scoreRow(assetId, asOfDate, score) {
  return { instrument_id: assetId, as_of_date: asOfDate, score: score.score,
    components: score.components, reasons: score.reasons, model_version: score.modelVersion,
    signal_context: { confidence: score.confidence, classification: score.classification,
      risks: score.risks, missing: score.missing, catalysts: score.catalysts } };
}

/** Pipeline injectable pour les tests ; aucune clé n'entre dans le rapport. */
export async function runDailyAnalysis(options = {}) {
  const writeLog = options.log ?? console.log;
  const log = value => writeLog(redactLogText(value));
  log('[DAILY] start');
  const settings = options.settings ?? config;
  const dryRun = options.dryRun ?? settings.dryRun;
  if (settings.paperTrading !== true || settings.tradingMode !== 'paper' || typeof dryRun !== 'boolean') throw new Error('Mode paper/dry-run invalide.');
  const now = options.now ?? new Date();
  const asOfDate = isoDate(now, settings.timezone);
  const startDate = new Date(dateDay(asOfDate) - settings.historyLookbackDays * 86400000).toISOString().slice(0, 10);
  const universe = options.universe ?? loadUniverse(settings);
  log('[MARKET] start');
  const provider = options.provider ?? await createMarketDataProvider(settings);
  const repository = options.repository ?? new InvestmentRepository();
  let run;
  log(`[MARKET] ${asOfDate} ${settings.marketDataProvider} — ${dryRun ? 'DRY_RUN, aucune écriture' : 'PAPER_TRADING, ouverture suivante'}`);
  try {
    log('[PORTFOLIO] start');
    let portfolioRow = await repository.getPortfolio();
    if (portfolioRow.trading_mode !== 'paper' || Number(portfolioRow.initial_capital_eur) !== 1000) throw new Error('Portefeuille initial incompatible.');
    if (!dryRun) {
      run = await repository.acquire(portfolioRow.id, asOfDate);
      if (run.status === 'completed') {
        log('[PORTFOLIO] Analyse déjà terminée aujourd’hui ; aucune transaction rejouée.');
        log('[PORTFOLIO] done');
        return { status: 'already_completed', date: asOfDate, dryRun: false, runId: run.id };
      }
      await repository.configurePortfolio(portfolioRow.id, settings);
    }
    const heartbeat = async () => { if (run) await repository.heartbeat(run); };
    const existingAssets = await repository.getAssets();
    const positionsRows = await repository.getPositions(portfolioRow.id);
    const previousSnapshot = await repository.getPreviousSnapshot(portfolioRow.id, asOfDate);
    const transactions = await repository.getTransactions(portfolioRow.id);
    const tradeHistory = transactions.map(trade => ({ instrumentId: trade.instrument_id, tradeDate: trade.trade_date,
      side: trade.side, scoreAtTrade: numeric(trade.invest_recommendations?.score) }));
    log('[PORTFOLIO] done');
    const assets = [];
    for (const instrument of universe.instruments.filter(item => item.enabled !== false)) {
      const existing = existingAssets.find(item => item.symbol === instrument.symbol && item.exchange === instrument.exchange);
      let metadata;
      try { metadata = await provider.getAssetMetadata(instrument.providerSymbol); }
      catch { log(`[MARKET] ${instrument.providerSymbol} métadonnées indisponibles ; devise configurée à vérifier sur les bougies.`); }
      if (metadata && metadata.currency !== instrument.currency) throw new Error(`Devise incohérente pour ${instrument.providerSymbol}.`);
      const row = { symbol: instrument.symbol, exchange: instrument.exchange, currency: instrument.currency,
        region: instrument.region, provider_symbol: instrument.providerSymbol, enabled: true,
        name: metadata?.name ?? existing?.name ?? instrument.symbol };
      assets.push(dryRun ? { ...row, id: existing?.id ?? `preview:${instrument.symbol}@${instrument.exchange}`, buyAllowed: true }
        : { ...await repository.syncAsset(row), buyAllowed: true });
      await heartbeat();
    }
    for (const position of positionsRows) {
      if (!assets.some(asset => asset.id === position.instrument_id)) {
        const asset = existingAssets.find(item => item.id === position.instrument_id);
        if (!asset?.provider_symbol) throw new Error('Position hors watchlist sans symbole fournisseur.');
        assets.push({ ...asset, buyAllowed: false });
      }
    }
    const benchmarkMetadata = await provider.getAssetMetadata(universe.benchmark.providerSymbol);
    const benchmarkRow = { name: universe.benchmark.name, kind: 'etf_proxy', return_type: universe.benchmark.returnType,
      currency: benchmarkMetadata.currency, provider_symbol: universe.benchmark.providerSymbol };
    if (portfolioRow.benchmark_base_level_eur !== null) {
      const oldBenchmark = await repository.getBenchmark(portfolioRow.benchmark_id);
      if (oldBenchmark.provider_symbol !== benchmarkRow.provider_symbol || oldBenchmark.currency !== benchmarkRow.currency
        || oldBenchmark.kind !== 'etf_proxy') throw new Error('Benchmark déjà initialisé différemment ; préserver l’historique.');
    }
    const benchmark = dryRun ? { ...benchmarkRow, id: portfolioRow.benchmark_id } : await repository.syncBenchmark(benchmarkRow);
    const rawBenchmark = await provider.getDailyHistory(benchmark.provider_symbol, startDate, asOfDate);
    const benchmarkHistory = rawBenchmark.filter(row => row.isFinal && row.date <= asOfDate);
    if (!benchmarkHistory.length || age(asOfDate, benchmarkHistory.at(-1).date) > settings.maxPriceAgeDays) throw new Error('Benchmark absent ou ancien.');
    const fx = [];
    for (const currency of new Set([...assets.map(asset => asset.currency), benchmark.currency])) {
      if (currency !== 'EUR') fx.push(...await provider.getFxHistory(currency, startDate, asOfDate));
      await heartbeat();
    }
    fx.sort((a, b) => a.date.localeCompare(b.date));
    const convertedBenchmark = eurHistory(benchmarkHistory, benchmark.currency, fx, settings);
    if (!Number.isFinite(convertedBenchmark.at(-1)?.adjustedClose)) throw new Error('Benchmark EUR non valorisable.');
    log('[MARKET] done');
    const histories = new Map();
    const prices = new Map();
    const metricsRows = [];
    const scoresRows = [];
    const candidates = [];
    let imported = 0;
    for (const asset of assets) {
      try {
        log('[MARKET] start');
        const raw = await provider.getDailyHistory(asset.provider_symbol, startDate, asOfDate);
        if (!dryRun && raw.some(row => row.date === asOfDate && !row.isFinal)) throw new Error('Séance encore ouverte : relancer après clôture + 15 minutes.');
        const history = raw.filter(row => row.isFinal && row.date <= asOfDate);
        if (!history.length) throw new Error('Aucune clôture complète.');
        if (history.some(row => row.currency !== asset.currency)) throw new Error('Devise des bougies incohérente.');
        const last = history.at(-1);
        const held = positionsRows.find(position => position.instrument_id === asset.id);
        if (held && age(asOfDate,last.date)>settings.maxPriceAgeDays) throw new Error('Cours de position trop ancien pour une valorisation fiable.');
        const since = previousSnapshot?.snapshot_date ?? transactions.filter(t => t.instrument_id === asset.id).at(-1)?.price_date;
        if (held && history.some(row => row.splitRatio && row.splitRatio !== 1 && (!since || row.date > since))) {
          throw new Error('Split affectant une position : réconciliation nécessaire avant toute transaction.');
        }
        const priceRows = history.map(row => ({ instrument_id: asset.id, price_date: row.date,
          open: row.open, high: row.high, low: row.low, close: row.close, adjusted_close: row.adjustedClose,
          volume: row.volume, source: provider.source, adjustment_method: 'Yahoo splits/dividends',
          is_final: true, dividend: row.dividend ?? null, split_ratio: row.splitRatio ?? null }));
        if (!dryRun) await repository.savePrices(priceRows);
        imported += priceRows.length;
        log(`[MARKET] ${asset.provider_symbol} ${priceRows.length} lignes ${dryRun ? 'récupérées' : 'upsertées (nouvelles ou actualisées)'}, clôture ${last.date}`);
        histories.set(asset.id, history);
        prices.set(asset.id, last);
        log('[MARKET] done');
        log('[INDICATORS] start');
        const metrics = calculateIndicators(history);
        const eurSeries = eurHistory(history, asset.currency, fx, settings);
        const comparableBenchmark = convertedBenchmark.filter(row => row.date <= last.date);
        const turnover = history.slice(-20).map(row => {
          const rate = fxAt(fx, asset.currency, row.date, settings.maxPriceAgeDays);
          return row.volume === null || rate === null ? null : row.volume * row.close * rate;
        });
        const fresh = age(asOfDate, last.date) <= settings.maxPriceAgeDays
          && comparableBenchmark.length && age(last.date, comparableBenchmark.at(-1).date) <= settings.maxPriceAgeDays;
        const indicators = { ...metrics, asOfDate, dataFresh: Boolean(fresh),
          return1mEur: calendarReturn(eurSeries, 1), marketReturn1m: calendarReturn(comparableBenchmark, 1, last.date),
          sectorReturn1m: null, earnings: null, catalysts: [],
          liquidityRisk: turnover.length === 20 && turnover.every(value => value !== null)
            ? turnover.reduce((sum, value) => sum + value, 0) / 20 < settings.strategy.risk.minAverageTurnoverEur : null,
          eventRisk: null };
        // Pas de substitution native si la comparaison EUR manque.
        if (indicators.return1mEur === null) indicators.marketReturn1m = null;
        log('[INDICATORS] done');
        log('[SCORING] start');
        const score = calculateInvestmentScore(indicators, settings.strategy);
        log('[SCORING] done');
        metricsRows.push(toMetricsRow(asset.id, asOfDate, indicators));
        scoresRows.push(scoreRow(asset.id, asOfDate, score));
        const rate = fxAt(fx, asset.currency, last.date, settings.maxPriceAgeDays);
        candidates.push({ instrumentId: asset.id, symbol: asset.provider_symbol, indicators,
          priceEur: rate === null ? null : last.close * rate, feesEur: settings.paperFeeEur,
          executionReady: Boolean(fresh && rate !== null), buyAllowed: asset.buyAllowed });
        log(`[INDICATORS] ${asset.provider_symbol} MA200=${metrics.ma200?.toFixed(2) ?? 'n/a'} RSI14=${metrics.rsi14?.toFixed(1) ?? 'n/a'} ; ${metrics.diagnostics.missing.length} indicateurs absents`);
        log(`[SCORING] ${asset.provider_symbol} ${score.score ?? 'n/a'}/100 ${score.classification}, couverture ${(score.confidence * 100).toFixed(0)} %, absents=${score.missing.join(',')}`);
      } catch (error) {
        log(`[MARKET] ${asset.provider_symbol} ignoré : ${error.message}`);
        if (positionsRows.some(position => position.instrument_id === asset.id)) throw error;
        if (!dryRun && error.message.includes('Séance encore ouverte')) throw error;
        candidates.push({ instrumentId: asset.id, symbol: asset.provider_symbol, indicators: { asOfDate }, executionReady: false, dataError: error.message });
      }
      await heartbeat();
    }
    if (!histories.size) throw new Error('Aucun actif exploitable ; aucune modification du portefeuille.');
    if (!dryRun) {
      log('[MARKET] start');
      await repository.saveFx(fx.map(row => ({ rate_date: row.date, currency: row.currency, eur_per_unit: row.eurPerUnit,
        open_eur_per_unit: row.openEurPerUnit, source: row.source })));
      await repository.saveBenchmarkPrices(benchmarkHistory.filter(row => row.adjustedClose !== null).map(row => ({
        benchmark_id: benchmark.id, price_date: row.date, level: row.adjustedClose, source: provider.source })));
      log('[MARKET] done');
      log('[INDICATORS] start');
      await repository.saveMetrics(metricsRows);
      log('[INDICATORS] done');
      log('[SCORING] start');
      await repository.saveScores(scoresRows);
      log('[SCORING] done');
    }
    log('[PORTFOLIO] start');
    let portfolio = valuePortfolio(portfolioInput(portfolioRow, positionsRows, assets), prices, fx);
    log(`[PORTFOLIO] valeur=${portfolio.totalValueEur.toFixed(2)} EUR cash=${portfolio.cashEur.toFixed(2)} EUR positions=${portfolio.positions.length}`);
    // L'historique des scores est utilisé par la RPC pour les ordres en attente.
    let recommendations = generateRecommendations({ asOfDate, portfolio, candidates, tradeHistory, includeNoActionAssets: true }, settings.strategy);
    if (!dryRun) await repository.saveRecommendations(recommendations.map(record => toRecommendationRow(record, run.id)));
    for (const record of recommendations) log(`[PORTFOLIO] ${record.action} ${record.symbol ?? 'GLOBAL'} ${record.classification ?? '-'} score=${record.score ?? 'n/a'} montant=${record.proposedAmountEur?.toFixed(2) ?? '-'} EUR`);
    const executed = [];
    if (!dryRun) {
      await heartbeat();
      const pending = await repository.getPendingOrders(portfolioRow.id, asOfDate);
      const latestByAsset = new Map();
      for (const order of pending) latestByAsset.set(order.instrument_id, order);
      const alreadyToday = transactions.filter(row => row.trade_date === asOfDate).length;
      const rankedOrders = [...latestByAsset.values()].sort((a,b) =>
        Number(b.action==='SELL')-Number(a.action==='SELL') || Number(b.score)-Number(a.score)
        || String(assets.find(asset => asset.id===a.instrument_id)?.provider_symbol ?? a.instrument_id)
          .localeCompare(String(assets.find(asset => asset.id===b.instrument_id)?.provider_symbol ?? b.instrument_id)));
      for (const order of rankedOrders) {
        if (executed.length + alreadyToday >= settings.maxTradesPerDay) break;
        const history = histories.get(order.instrument_id);
        const today = history?.find(row => row.date === asOfDate);
        const signalDate = order.decision_context?.signalDate;
        if (!signalDate || history?.some(row => row.date > signalDate && row.date < asOfDate)) {
          await repository.rejectOrder(order.id, 'Signal expiré');
          log('[TRADES] signal expiré, aucune exécution rétroactive.');
          continue;
        }
        if (!today) continue;
        try {
          const results = await executePaperTrades({ repository, run, orders: [order], dryRun: false, paperTrading: true,
            remainingSlots: settings.maxTradesPerDay - alreadyToday - executed.length, feesEur: settings.paperFeeEur });
          executed.push(...results);
          for (const fill of results) log(`[TRADES] ${fill.side} ${assets.find(asset => asset.id === fill.instrumentId)?.provider_symbol} ${Number(fill.amountEur).toFixed(2)} EUR à l’ouverture, virtuel`);
        } catch (error) {
          log(`[TRADES] ordre refusé : ${error.message}`);
          // L'expiration/limite est une décision, pas une panne masquée.
          if (/Lease|run ou mode|schema cache|function|permission|fetch failed/i.test(error.message)) throw error;
          await repository.rejectOrder(order.id, error.message);
        }
      }
      portfolioRow = await repository.getPortfolio();
      const updatedPositions = await repository.getPositions(portfolioRow.id);
      portfolio = valuePortfolio(portfolioInput(portfolioRow, updatedPositions, assets), prices, fx);
      if (executed.length) {
        const freshTrades = await repository.getTransactions(portfolioRow.id);
        recommendations = generateRecommendations({ asOfDate, portfolio, candidates, includeNoActionAssets: true,
          tradeHistory: freshTrades.map(trade => ({ instrumentId: trade.instrument_id, tradeDate: trade.trade_date,
            side: trade.side, scoreAtTrade: numeric(trade.invest_recommendations?.score) })) }, settings.strategy);
        await repository.saveRecommendations(recommendations.map(record => toRecommendationRow(record, run.id)));
        log('[PORTFOLIO] Recommandations recalculées après exécutions virtuelles.');
      }
    }
    if (!executed.length) log(`[TRADES] 0 transaction — ${dryRun ? 'DRY_RUN, aucune écriture' : 'aucun ordre antérieur exécutable ; nouveaux signaux pour la séance suivante'}`);
    log('[PORTFOLIO] done');
    log('[PERFORMANCE] start');
    const benchmarkLast = convertedBenchmark.at(-1);
    const benchmarkLevel = benchmarkLast?.adjustedClose ?? null;
    const base = numeric(portfolioRow.benchmark_base_level_eur) ?? benchmarkLevel;
    const performance = calculatePerformance({ totalValueEur: portfolio.totalValueEur,
      previousValueEur: numeric(previousSnapshot?.total_value_eur), benchmarkLevelEur: benchmarkLevel, benchmarkBaseLevelEur: base });
    log(`[PERFORMANCE] valeur=${portfolio.totalValueEur.toFixed(2)} EUR cumul=${(performance.cumulativeReturn * 100).toFixed(2)} % ; ${benchmark.name}=${performance.benchmarkCumulativeReturn === null ? 'n/a' : (performance.benchmarkCumulativeReturn * 100).toFixed(2) + ' %'}`);
    if (!dryRun) {
      await heartbeat();
      await repository.finish(run, { cash_eur: portfolio.cashEur, invested_cost_eur: portfolio.investedCostEur,
        positions_value_eur: portfolio.positionsValueEur, daily_return: performance.dailyReturn, cumulative_return: performance.cumulativeReturn,
        benchmark_level_eur: benchmarkLevel, benchmark_price_date: benchmarkLast.date,
        benchmark_cumulative_return: performance.benchmarkCumulativeReturn, excess_return: performance.excessReturn,
        positions_detail: portfolio.positions, valuation_context: { source: provider.source, executionModel: 'next-session-open',
          dividendsCredited: false, configuredStrategy: settings.strategy } }, benchmark.id);
    }
    log('[PERFORMANCE] done');
    return { status: 'completed', dryRun, date: asOfDate, runId: run?.id ?? null, importedRows: imported,
      benchmark: { name: benchmark.name, priceDate: benchmarkLast.date, cumulativeReturn: performance.benchmarkCumulativeReturn },
      portfolio, performance, recommendations, executedTransactions: executed };
  } catch (error) {
    if (run) { try { await repository.fail(run, error.message); } catch { log('[PORTFOLIO] échec de finalisation du run ; reprise après expiration de lease.'); } }
    throw error;
  }
}
