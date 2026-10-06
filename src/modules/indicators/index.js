import { dateDay } from '../scoring/index.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

export function movingAverage(values, period) {
  if (values.length < period || !values.slice(-period).every(finite)) return null;
  return mean(values.slice(-period));
}

export function wilderRsi(values, period = 14) {
  if (values.length < period + 1 || !values.every(finite)) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gain += Math.max(delta, 0) / period;
    loss += Math.max(-delta, 0) / period;
  }
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function annualizedVolatility(values, period) {
  if (values.length < period + 1 || !values.slice(-period - 1).every(value => finite(value) && value > 0)) return null;
  const tail = values.slice(-period - 1);
  const returns = tail.slice(1).map((value, index) => Math.log(value / tail[index]));
  const average = mean(returns);
  return Math.sqrt(returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (period - 1)) * Math.sqrt(252);
}

function monthsBefore(date, months) {
  const original = new Date(dateDay(date));
  const target = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}

export function calendarReturn(history, months, endDate = history.at(-1)?.date) {
  if (!history.length) return null;
  const last = history.findLast(row => row.date <= endDate);
  if (!last) return null;
  const target = monthsBefore(endDate, months);
  const previous = history.findLast(row => row.date <= target);
  return previous && finite(previous.adjustedClose) && previous.adjustedClose > 0
    && finite(last.adjustedClose) ? last.adjustedClose / previous.adjustedClose - 1 : null;
}

/** Historique normalisé, bougies clôturées uniquement ; jamais de remplissage. */
export function calculateIndicators(history) {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map(row => row.date)).size !== sorted.length
    || sorted.some(row => !Number.isFinite(dateDay(row.date)) || row.isFinal === false)) {
    throw new Error('Historique indicateurs invalide : dates, doublons ou séance incomplète.');
  }
  const values = sorted.map(row => row.adjustedClose);
  const last = sorted.at(-1);
  const valid = values.every(value => finite(value) && value > 0);
  const sessionReturn = sessions => valid && values.length > sessions ? values.at(-1) / values.at(-sessions - 1) - 1 : null;
  const adjustedHigh = row => finite(row.high) && finite(row.close) && row.close > 0
    && finite(row.adjustedClose) ? row.high * row.adjustedClose / row.close : null;
  const highWindow = size => {
    const rows = sorted.slice(-size);
    return valid && rows.length === size && rows.every(row => finite(adjustedHigh(row)))
      ? Math.max(...rows.map(adjustedHigh)) : null;
  };
  const previousHigh60 = sorted.length >= 61 && valid
    && sorted.slice(-61, -1).every(row => finite(adjustedHigh(row)))
    ? Math.max(...sorted.slice(-61, -1).map(adjustedHigh)) : null;
  const previousHigh252 = sorted.length >= 253 && valid
    && sorted.slice(-253, -1).every(row => finite(adjustedHigh(row)))
    ? Math.max(...sorted.slice(-253, -1).map(adjustedHigh)) : null;
  const priorVolumes = sorted.slice(-21, -1).map(row => row.volume);
  const volumeRatio20 = sorted.length >= 21 && finite(last.volume) && last.volume >= 0
    && priorVolumes.every(value => finite(value) && value >= 0) && mean(priorVolumes) > 0
    ? last.volume / mean(priorVolumes) : null;
  const currentHigh252 = highWindow(252);
  const result = {
    lastPriceDate: last?.date ?? null,
    return5d: sessionReturn(5),
    previousReturn5d: valid && values.length >= 11 ? values.at(-6) / values.at(-11) - 1 : null,
    return1m: valid ? calendarReturn(sorted, 1) : null,
    return3m: valid ? calendarReturn(sorted, 3) : null,
    return6m: valid ? calendarReturn(sorted, 6) : null,
    return12m: valid ? calendarReturn(sorted, 12) : null,
    sma20: valid ? movingAverage(values, 20) : null,
    sma50: valid ? movingAverage(values, 50) : null,
    ma200: valid ? movingAverage(values, 200) : null,
    rsi14: valid ? wilderRsi(values) : null,
    volatility20: annualizedVolatility(values, 20),
    volatility30: annualizedVolatility(values, 30),
    volatility60: annualizedVolatility(values, 60),
    volumeRatio20,
    distanceToHigh60: previousHigh60 ? last.adjustedClose / previousHigh60 - 1 : null,
    distance52wHigh: previousHigh252 ? last.adjustedClose / previousHigh252 - 1 : null,
    drawdown52w: currentHigh252 ? Math.min(0, last.adjustedClose / currentHigh252 - 1) : null,
    historyComplete: valid && sorted.length >= 200 && previousHigh60 !== null,
    calculationVersion: 'daily-indicators-v1',
    diagnostics: { observations: sorted.length, adjustedPricesValid: valid },
  };
  result.diagnostics.missing = Object.entries(result).filter(([, value]) => value === null).map(([key]) => key);
  return result;
}

export function toMetricsRow(instrumentId, asOfDate, metrics) {
  return {
    instrument_id: instrumentId, as_of_date: asOfDate, last_price_date: metrics.lastPriceDate,
    return_5d: metrics.return5d, return_1m: metrics.return1m, return_3m: metrics.return3m,
    return_6m: metrics.return6m, return_12m: metrics.return12m,
    sma_20: metrics.sma20, sma_50: metrics.sma50, ma200: metrics.ma200, rsi_14: metrics.rsi14,
    volatility_30: metrics.volatility30, volatility20: metrics.volatility20, volatility60: metrics.volatility60,
    volume_ratio: metrics.volumeRatio20, distance_52w_high: metrics.distance52wHigh, drawdown_52w: metrics.drawdown52w,
    history_complete: metrics.historyComplete, diagnostics: metrics.diagnostics,
    calculation_version: metrics.calculationVersion, signal_features: metrics,
  };
}
