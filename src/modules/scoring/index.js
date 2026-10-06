import { config } from '../../config/env.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 10000) / 10000;
export function dateDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

/** Un catalyseur exige une source, une date passée/récente et une force signée. */
export function validCatalysts(indicators, parameters = config.strategy) {
  const asOf = dateDay(indicators.asOfDate);
  return (Array.isArray(indicators.catalysts) ? indicators.catalysts : []).filter(event => {
    if (!event || typeof event !== 'object') return false;
    const age = (asOf - dateDay(event.date)) / 86400000;
    return parameters.evidence.catalystTypes.includes(event.type)
      && typeof event.source === 'string' && event.source.trim().length > 0
      && typeof event.description === 'string' && event.description.trim().length > 0
      && finite(event.strength) && event.strength >= -1 && event.strength <= 1
      && age >= 0 && age <= parameters.evidence.maxAgeDays;
  });
}

/** Fonction déterministe ; rendements en fractions, volumes en ratio. */
export function calculateInvestmentScore(indicators, parameters = config.strategy) {
  const catalysts = validCatalysts(indicators, parameters);
  const subtract = (a, b) => finite(a) && finite(b) ? a - b : null;
  const positiveMomentum = finite(indicators.return5d) && indicators.return5d > 0;
  const earnings = indicators.earnings;
  const earningsAge = earnings ? (dateDay(indicators.asOfDate) - dateDay(earnings.date)) / 86400000 : NaN;
  const earningsValid = earnings && typeof earnings.source === 'string' && earnings.source.trim()
    && earningsAge >= 0 && earningsAge <= parameters.evidence.maxAgeDays
    && finite(earnings.surprisePct);
  const raw = {
    momentum1m: indicators.return1m,
    momentum3m: indicators.return3m,
    acceleration: subtract(indicators.return5d, indicators.previousReturn5d),
    // Un volume élevé accompagnant une baisse n'est pas un signal positif.
    unusualVolume: positiveMomentum ? indicators.volumeRatio20 : (finite(indicators.return5d) ? 0 : null),
    breakout: indicators.distanceToHigh60,
    relativeMarket: subtract(indicators.return1mEur ?? indicators.return1m, indicators.marketReturn1m),
    relativeSector: subtract(indicators.return1m, indicators.sectorReturn1m),
    growthResults: earningsValid ? earnings.surprisePct : null,
    // Une seule preuve forte : pas de bonus obtenu en dupliquant les news.
    catalysts: catalysts.length ? catalysts.reduce((best, event) =>
      Math.abs(event.strength) > Math.abs(best)
        || (Math.abs(event.strength) === Math.abs(best) && event.strength < best)
        ? event.strength : best, catalysts[0].strength) : null,
  };
  const components = {};
  const reasons = [];
  const missing = [];
  let score = 0;
  let coverage = 0;
  for (const [name, weight] of Object.entries(parameters.weights)) {
    if (!finite(raw[name])) {
      components[name] = { raw: null, score: null, weight, contribution: 0 };
      missing.push(name);
      continue;
    }
    const [low, high] = parameters.normalization[name];
    const normalized = Math.max(0, Math.min(100, (raw[name] - low) / (high - low) * 100));
    const contribution = normalized * weight / 100;
    components[name] = { raw: raw[name], score: round(normalized), weight, contribution: round(contribution) };
    score += contribution;
    coverage += weight / 100;
    if (normalized >= parameters.signals.minConfirmationScore) reasons.push(`${name} : ${round(normalized)}/100`);
  }
  const ready = indicators.historyComplete === true && indicators.dataFresh === true
    && Number.isFinite(dateDay(indicators.asOfDate))
    && ['momentum1m', 'momentum3m', 'acceleration', 'unusualVolume', 'breakout', 'relativeMarket']
      .every(name => components[name].score !== null);
  const classification = !finite(indicators.volatility30) || indicators.volatility30 < 0
    || indicators.volatility30 >= parameters.risk.speculativeVolatility
    || indicators.liquidityRisk === true || indicators.eventRisk === true ? 'SPECULATIVE' : 'CORE';
  const risks = [];
  if (!finite(indicators.volatility30) || indicators.volatility30 < 0) risks.push('Volatilité inconnue ou invalide.');
  else if (indicators.volatility30 >= parameters.risk.speculativeVolatility) risks.push('Volatilité annualisée élevée.');
  if (indicators.liquidityRisk !== false) risks.push('Risque de liquidité présent ou non évalué.');
  if (indicators.eventRisk !== false) risks.push('Risque événementiel présent ou non évalué.');
  if (missing.length) risks.push(`Données absentes : ${missing.join(', ')} ; poids non redistribués.`);
  if (!ready) risks.push('Historique, données fraîches ou facteurs techniques insuffisants.');
  for (const event of catalysts) {
    if (event.strength > 0) reasons.push(`${event.description} (${event.source}, ${event.date})`);
    else if (event.strength < 0) risks.push(`${event.description} (${event.source}, ${event.date})`);
  }
  return {
    score: ready ? round(score) : null,
    components, reasons, risks, missing, catalysts,
    confidence: ready ? round(coverage) : 0,
    classification, riskLevel: classification === 'SPECULATIVE' ? 'VERY_HIGH' : 'HIGH',
    horizon: parameters.risk.horizon,
    modelVersion: parameters.modelVersion,
    asOfDate: indicators.asOfDate,
  };
}
