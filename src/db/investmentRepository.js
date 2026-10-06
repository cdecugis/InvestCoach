import { getSupabase, TABLES } from './supabase.js';
import { randomUUID } from 'node:crypto';

function resultOrThrow(result, operation) {
  if (result.error) throw new Error(`${operation} : ${result.error.message}`);
  return result.data;
}

export class InvestmentRepository {
  constructor(client = getSupabase()) { this.client = client; }
  table(key) { return this.client.from(TABLES[key]); }
  async rpc(name, args) { return resultOrThrow(await this.client.rpc(name, args), name); }
  async all(key, configure = query => query) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const data = resultOrThrow(await configure(this.table(key).select('*')).range(offset, offset + 499), `lecture ${TABLES[key]}`);
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }
  async upsert(key, rows, conflict) {
    for (let offset = 0; offset < rows.length; offset += 500) {
      resultOrThrow(await this.table(key).upsert(rows.slice(offset, offset + 500), { onConflict: conflict }), `upsert ${TABLES[key]}`);
    }
    return rows.length;
  }
  async getPortfolio() {
    return resultOrThrow(await this.table('portfolio').select('*').eq('name', 'InvestmentAdvisor').single(), 'portefeuille');
  }
  getAssets() { return this.all('assets', query => query.order('id')); }
  getPositions(id) { return this.all('positions', query => query.eq('portfolio_id', id).order('instrument_id')).then(rows => rows.filter(row => !row.closed_at)); }
  async getTransactions(id) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const data = resultOrThrow(await this.table('transactions').select('*,invest_recommendations(score)')
        .eq('portfolio_id', id).order('executed_at').order('id').range(offset, offset + 499), 'historique transactions');
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }
  async getPreviousSnapshot(id, date) {
    const data = resultOrThrow(await this.table('portfolioDaily').select('*').eq('portfolio_id', id).lt('snapshot_date', date)
      .order('snapshot_date', { ascending: false }).limit(1), 'snapshot précédent');
    return data[0] ?? null;
  }
  async getBenchmark(id) {
    return resultOrThrow(await this.table('benchmarks').select('*').eq('id', id).single(), 'benchmark du portefeuille');
  }
  async syncAsset(row) {
    return resultOrThrow(await this.table('assets').upsert(row, { onConflict: 'symbol,exchange' }).select('*').single(), 'synchronisation actif');
  }
  async syncBenchmark(row) {
    return resultOrThrow(await this.table('benchmarks').upsert(row, { onConflict: 'name,kind,return_type,currency' }).select('*').single(), 'synchronisation benchmark');
  }
  acquire(id, date) { return this.rpc('invest_acquire_daily_run', { p_portfolio_id: id, p_run_date: date }); }
  heartbeat(run) { return this.rpc('invest_heartbeat', { p_run_id: run.id, p_lease_token: run.leaseToken }); }
  async configurePortfolio(id, settings) {
    resultOrThrow(await this.table('portfolio').update({ risk_profile: settings.riskProfile,
      max_positions: settings.maxPositions, max_position_weight: settings.maxPositionWeight,
      max_daily_trades: settings.maxTradesPerDay, min_order_eur: settings.minOrderEur,
      stop_review_pct: settings.strategy.review.stopReviewPct, take_profit_review_pct: settings.strategy.review.takeProfitReviewPct,
      cooldown_days: settings.strategy.cooldown.days }).eq('id', id), 'paramètres portefeuille');
  }
  savePrices(rows) { return this.upsert('marketPrices', rows, 'asset_id,date'); }
  saveFx(rows) { return this.upsert('fxRates', rows, 'rate_date,currency'); }
  saveBenchmarkPrices(rows) { return this.upsert('benchmarkPrices', rows, 'benchmark_id,price_date'); }
  saveMetrics(rows) { return this.upsert('dailyMetrics', rows, 'instrument_id,as_of_date'); }
  saveScores(rows) { return this.upsert('dailyScores', rows, 'instrument_id,as_of_date'); }
  async saveRecommendations(rows) {
    // Pas d'effacement des décisions. Sur une reprise, préserver les UUID.
    const existing = await this.all('recommendations', query => query.eq('run_id', rows[0].run_id).order('id'));
    const mapped = rows.map(row => ({ ...row,
      id: existing.find(old => old.instrument_id === row.instrument_id)?.id ?? randomUUID() }));
    for (const old of existing.filter(old => !rows.some(row => row.instrument_id === old.instrument_id))) {
      resultOrThrow(await this.table('recommendations').update({ status: 'rejected',
        decision_context: { ...old.decision_context, supersededAfterPaperTrades: true } }).eq('id', old.id), 'révision des décisions');
    }
    return this.upsert('recommendations', mapped, 'id');
  }
  async getPendingOrders(id, date) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const data = resultOrThrow(await this.table('recommendations').select('*,invest_daily_runs!inner(portfolio_id,run_date,status)')
        .eq('status', 'proposed').in('action', ['BUY', 'SELL']).eq('invest_daily_runs.portfolio_id', id)
        .eq('invest_daily_runs.status', 'completed').lt('invest_daily_runs.run_date', date)
        .order('created_at').order('id').range(offset, offset + 499), 'ordres virtuels proposés');
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }
  async getPriceHistory(id, start, end) {
    return this.all('marketPrices', query => query.eq('instrument_id', id).gte('price_date', start).lte('price_date', end).order('price_date'));
  }
  executeTrade(run, recommendationId, feesEur) {
    return this.rpc('invest_execute_paper_trade', { p_run_id: run.id, p_lease_token: run.leaseToken,
      p_recommendation_id: recommendationId, p_fees_eur: feesEur });
  }
  finish(run, snapshot, benchmarkId) {
    return this.rpc('invest_finish_daily_run', { p_run_id: run.id, p_lease_token: run.leaseToken,
      p_snapshot: snapshot, p_benchmark_id: benchmarkId });
  }
  async rejectOrder(id, reason = 'Signal expiré') {
    const existing = resultOrThrow(await this.table('recommendations').select('decision_context')
      .eq('id', id).maybeSingle(), 'contexte ordre');
    resultOrThrow(await this.table('recommendations').update({ status: 'rejected',
      decision_context: { ...existing?.decision_context, executionRejection: String(reason).slice(0, 500) } })
      .eq('id', id).eq('status', 'proposed'), 'expiration ordre');
  }
  async fail(run, message) {
    resultOrThrow(await this.table('dailyRuns').update({ status: 'failed', error_message: message.slice(0, 500), lease_until: null })
      .eq('id', run.id).eq('lease_token', run.leaseToken).eq('status', 'running'), 'échec run');
  }
}
