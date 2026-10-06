import 'dotenv/config';
import { readFileSync } from 'node:fs';

const profiles = JSON.parse(readFileSync(new URL('../../config/strategy.json', import.meta.url), 'utf8'));
const riskProfile = process.env.RISK_PROFILE ?? 'AGGRESSIVE';
if (!Object.hasOwn(profiles, riskProfile)) throw new Error(`RISK_PROFILE inconnu : ${riskProfile}`);
const strategy = profiles[riskProfile];
for (const [variable, key, valid] of [
  ['STOP_REVIEW_PCT', 'stopReviewPct', value => value > -100 && value < 0],
  ['TAKE_PROFIT_REVIEW_PCT', 'takeProfitReviewPct', value => value > 0],
]) {
  if (process.env[variable] !== undefined) {
    const value = Number(process.env[variable]);
    if (!Number.isFinite(value) || !valid(value)) throw new Error(`${variable} invalide.`);
    strategy.review[key] = value;
  }
}
if (process.env.COOLDOWN_DAYS !== undefined) {
  const days = Number(process.env.COOLDOWN_DAYS);
  if (!Number.isInteger(days) || days < 1) throw new Error('COOLDOWN_DAYS doit être un entier positif.');
  strategy.cooldown.days = days;
}
if (Object.values(strategy.weights).some(value => !Number.isFinite(value) || value < 0)
  || Object.values(strategy.weights).reduce((sum, value) => sum + value, 0) !== 100) {
  throw new Error('La somme des pondérations doit être 100.');
}
for (const key of Object.keys(strategy.weights)) {
  const bounds = strategy.normalization[key];
  if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[1]) {
    throw new Error(`Bornes de normalisation invalides : ${key}`);
  }
}
if (strategy.limits.maxInvestedCapitalEur !== 1000 || strategy.limits.maxPositionWeight > 0.35
  || strategy.limits.maxPositionWeight <= 0 || !Number.isInteger(strategy.limits.maxPositions)
  || strategy.limits.maxPositions < 1 || strategy.limits.maxPositions > 4
  || !Number.isInteger(strategy.limits.maxTradesPerDay) || strategy.limits.maxTradesPerDay < 1
  || strategy.limits.maxTradesPerDay > 2 || strategy.limits.minOrderEur < 100) {
  throw new Error('Limites du profil AGGRESSIVE invalides.');
}
function freezeDeep(value) {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object') freezeDeep(nested);
  return Object.freeze(value);
}
freezeDeep(strategy);

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT doit être un entier entre 1 et 65535.');
}
if (!['paper', 'PAPER_TRADING'].includes(process.env.TRADING_MODE ?? 'paper')) {
  throw new Error('InvestmentAdvisor autorise exclusivement le paper trading.');
}
if ((process.env.PAPER_TRADING ?? 'true') !== 'true') {
  throw new Error('PAPER_TRADING doit rester true ; aucune exécution réelle autorisée.');
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} invalide.`);
  return value;
}
const dryRun = process.env.DRY_RUN ?? 'true';
if (!['true', 'false'].includes(dryRun)) throw new Error('DRY_RUN doit être true ou false.');
const paperFeeEur = Number(process.env.PAPER_FEE_EUR ?? 0);
if (!Number.isFinite(paperFeeEur) || paperFeeEur < 0
  || Math.abs(paperFeeEur * 100 - Math.round(paperFeeEur * 100)) > 1e-6) throw new Error('PAPER_FEE_EUR invalide (montant au centime).');

export const config = Object.freeze({
  port,
  timezone: process.env.APP_TIMEZONE ?? 'Europe/Paris',
  universePath: process.env.UNIVERSE_CONFIG_PATH ?? './config/universe.json',
  tradingMode: 'paper',
  paperTrading: true,
  dryRun: dryRun === 'true',
  marketDataProvider: process.env.MARKET_DATA_PROVIDER || 'yahoo',
  benchmarkSymbol: process.env.BENCHMARK_PROVIDER_SYMBOL || 'IWDA.AS',
  historyLookbackDays: integerEnv('HISTORY_LOOKBACK_DAYS', 550, 400, 1500),
  marketTimeoutMs: integerEnv('MARKET_TIMEOUT_MS', 15000, 1000, 60000),
  marketRetries: integerEnv('MARKET_RETRIES', 3, 1, 5),
  marketDelayMs: integerEnv('MARKET_DELAY_MS', 250, 0, 10000),
  maxPriceAgeDays: integerEnv('MAX_PRICE_AGE_DAYS', 4, 0, 4),
  paperFeeEur,
  riskProfile,
  strategy,
  initialCapitalEur: 1000,
  ...strategy.limits,
});
