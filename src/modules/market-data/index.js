import { createMarketDataProvider } from '../../data/marketDataProvider.js';
import { config } from '../../config/env.js';

/**
 * Entrée : { asOfDate, instruments, benchmark, historyStartDate }.
 * Sortie : { histories: Map, benchmarkPrices, source }.
 * Cours bruts pour exécution ; clôtures ajustées pour indicateurs.
 * Le pipeline quotidien récupère séparément métadonnées et taux de change.
 */
export async function fetchDailyMarketData(input, provider = null) {
  const source = provider ?? await createMarketDataProvider(config);
  const histories = new Map();
  for (const instrument of input.instruments) histories.set(instrument.id ?? instrument.providerSymbol,
    await source.getDailyHistory(instrument.providerSymbol, input.historyStartDate, input.asOfDate));
  const benchmarkPrices = await source.getDailyHistory(input.benchmark.providerSymbol, input.historyStartDate, input.asOfDate);
  return { histories, benchmarkPrices, source: source.source };
}
