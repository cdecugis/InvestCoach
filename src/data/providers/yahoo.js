import YahooFinance from 'yahoo-finance2';
import { MarketDataProvider } from '../marketDataProvider.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const dateInZone = (value, timezone) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(value);

export class YahooProvider extends MarketDataProvider {
  constructor(settings, client = null, now = () => new Date()) {
    super();
    this.settings = settings;
    this.now = now;
    this.client = client ?? new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    this.metadata = new Map();
    this.source = 'yahoo';
  }

  async request(operation) {
    let lastError;
    for (let attempt = 0; attempt < this.settings.marketRetries; attempt += 1) {
      try {
        const result = await operation({ fetchOptions: { signal: AbortSignal.timeout(this.settings.marketTimeoutMs) } });
        if (this.settings.marketDelayMs) await new Promise(resolve => setTimeout(resolve, this.settings.marketDelayMs));
        return result;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < this.settings.marketRetries) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw new Error(`Yahoo : requête indisponible (${lastError?.name ?? 'Error'}).`);
  }

  async getAssetMetadata(symbol) {
    if (this.metadata.has(symbol)) return this.metadata.get(symbol);
    const quote = await this.request(options => this.client.quote(symbol, {}, options));
    const result = { symbol, name: quote.longName ?? quote.shortName ?? symbol,
      currency: quote.currency === 'GBp' ? 'GBX' : quote.currency,
      timezone: quote.exchangeTimezoneName ?? 'UTC', type: quote.quoteType };
    if (!result.currency) throw new Error(`Yahoo : devise absente pour ${symbol}.`);
    this.metadata.set(symbol, result);
    return result;
  }

  async getLatestQuote(symbol) {
    const quote = await this.request(options => this.client.quote(symbol, {}, options));
    return { symbol, price: quote.regularMarketPrice ?? null, currency: quote.currency,
      time: quote.regularMarketTime?.toISOString() ?? null, marketState: quote.marketState ?? null };
  }

  async getDailyHistory(symbol, startDate, endDate) {
    const exclusiveEnd = new Date(`${endDate}T00:00:00Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    const chart = await this.request(options => this.client.chart(symbol, {
      period1: startDate, period2: exclusiveEnd, interval: '1d', events: 'div,splits',
    }, options));
    const timezone = chart.meta.exchangeTimezoneName ?? 'UTC';
    const now = this.now();
    const today = dateInZone(now, timezone);
    const end = chart.meta.currentTradingPeriod?.regular?.end;
    const closeTime = end instanceof Date ? end.getTime() : (typeof end === 'number' ? end * 1000 : NaN);
    const sessionClosed = Number.isFinite(closeTime) && now.getTime() >= closeTime + 15 * 60000;
    const eventFor = (collection, date) => Object.values(collection ?? {})
      .find(event => dateInZone(new Date(event.date), timezone) === date);
    return chart.quotes.map(row => {
      const date = dateInZone(new Date(row.date), timezone);
      const split = eventFor(chart.events?.splits, date);
      return { date, open: row.open, high: row.high, low: row.low, close: row.close,
        adjustedClose: finite(row.adjclose) ? row.adjclose : null,
        volume: finite(row.volume) ? row.volume : null,
        currency: chart.meta.currency === 'GBp' ? 'GBX' : chart.meta.currency,
        isFinal: date < today || (date === today && sessionClosed),
        dividend: eventFor(chart.events?.dividends, date)?.amount ?? null,
        splitRatio: split ? split.numerator / split.denominator : null };
    }).filter(row => row.date >= startDate && row.date <= endDate
      && finite(row.close) && row.close > 0 && [row.open, row.high, row.low].every(value => finite(value) && value > 0))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getFxHistory(currency, startDate, endDate) {
    if (currency === 'EUR') return [];
    const normalized = currency === 'GBX' ? 'GBP' : currency;
    const invert = normalized === 'USD';
    const history = await this.getDailyHistory(invert ? 'EURUSD=X' : `${normalized}EUR=X`, startDate, endDate);
    return history.map(row => ({ date: row.date, currency,
      eurPerUnit: (invert ? 1 / row.close : row.close) * (currency === 'GBX' ? 0.01 : 1),
      openEurPerUnit: (invert ? 1 / row.open : row.open) * (currency === 'GBX' ? 0.01 : 1), source: this.source }));
  }
}
