import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

let client;

export const SUPABASE_PROJECT_REF = 'kqgfeusiwvycpuvecgab';
export const TABLES = Object.freeze({
  assets: 'invest_assets',
  marketPrices: 'invest_market_prices',
  fxRates: 'invest_fx_rates',
  benchmarks: 'invest_benchmarks',
  benchmarkPrices: 'invest_benchmark_prices',
  portfolio: 'invest_portfolio',
  dailyRuns: 'invest_daily_runs',
  dailyMetrics: 'invest_daily_metrics',
  dailyScores: 'invest_daily_scores',
  positions: 'invest_positions',
  recommendations: 'invest_recommendations',
  transactions: 'invest_transactions',
  portfolioDaily: 'invest_portfolio_daily',
  dailyEmailReports: 'invest_daily_email_reports',
  news: 'invest_news',
});

/** Connexion différée : /health fonctionne sans identifiants Supabase. */
export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL et SUPABASE_SECRET_KEY sont nécessaires aux traitements serveur.');
  if (url.replace(/\/$/, '') !== `https://${SUPABASE_PROJECT_REF}.supabase.co`) {
    throw new Error('SUPABASE_URL doit cibler le projet existant kqgfeusiwvycpuvecgab.');
  }
  if (!key.startsWith('sb_secret_')) throw new Error('SUPABASE_SECRET_KEY attend une clé secrète Supabase sb_secret_, jamais une clé publique.');
  client = createClient(url, key, {
    db: { schema: 'public' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Accès applicatif : aucun nom libre provenant d'une requête HTTP. */
export function getInvestmentTable(name) {
  if (!Object.hasOwn(TABLES, name)) throw new Error('Table InvestmentAdvisor inconnue.');
  return getSupabase().from(TABLES[name]);
}
