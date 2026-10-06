/** Contrat : bougies {date, open, high, low, close, adjustedClose, volume,
 * currency, isFinal, dividend, splitRatio}, sans dépendance au SDK du fournisseur. */
export class MarketDataProvider {
  async getDailyHistory(symbol, startDate, endDate) { throw new Error('getDailyHistory non implémenté'); }
  async getLatestQuote(symbol) { throw new Error('getLatestQuote non implémenté'); }
  async getAssetMetadata(symbol) { throw new Error('getAssetMetadata non implémenté'); }
  async getFxHistory(currency, startDate, endDate) { throw new Error('getFxHistory non implémenté'); }
}

export async function createMarketDataProvider(settings) {
  if (settings.marketDataProvider !== 'yahoo') throw new Error('MARKET_DATA_PROVIDER inconnu ; utiliser yahoo.');
  const { YahooProvider } = await import('./providers/yahoo.js');
  return new YahooProvider(settings);
}
