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
  saveFx(rows) {
    // Protection SQL même avec un autre fournisseur : un upsert ne peut contenir
    // deux lignes visant la même clé. Dernière valeur conservée, sans suppression.
    const unique = new Map(rows.map(row => [JSON.stringify([row.rate_date, row.currency]), row]));
    return this.upsert('fxRates', [...unique.values()], 'rate_date,currency');
  }
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
  async getCompletedRun(runId) {
    return resultOrThrow(await this.table('dailyRuns').select('*').eq('id', runId).eq('status', 'completed').single(), 'run finalisé');
  }
  async getCompletedReport(runId) {
    const run = await this.getCompletedRun(runId);
    const [snapshot, records, trades, assets, portfolio] = await Promise.all([
      this.table('portfolioDaily').select('*').eq('run_id', runId).single().then(result => resultOrThrow(result, 'snapshot finalisé')),
      this.all('recommendations', query => query.eq('run_id', runId).order('id')),
      this.all('transactions', query => query.eq('run_id', runId).order('daily_slot')),
      this.getAssets(), this.getPortfolio(),
    ]);
    const benchmark = await this.getBenchmark(portfolio.benchmark_id);
    const numeric = value => value == null ? null : Number(value);
    const symbol = id => assets.find(asset => asset.id === id)?.provider_symbol ?? assets.find(asset => asset.id === id)?.symbol ?? id;
    return { status: 'already_completed', dryRun: false, runId, date: run.run_date,
      portfolio: { id: run.portfolio_id, cashEur: numeric(snapshot.cash_eur), totalValueEur: numeric(snapshot.total_value_eur),
        investedCostEur: numeric(snapshot.invested_cost_eur), positionsValueEur: numeric(snapshot.positions_value_eur), positions: snapshot.positions_detail },
      performance: { dailyReturn: numeric(snapshot.daily_return), cumulativeReturn: numeric(snapshot.cumulative_return),
        benchmarkCumulativeReturn: numeric(snapshot.benchmark_cumulative_return), excessReturn: numeric(snapshot.excess_return) },
      benchmark: { name: benchmark.name, priceDate: snapshot.benchmark_price_date, cumulativeReturn: numeric(snapshot.benchmark_cumulative_return) },
      recommendations: records.map(record => ({ instrumentId: record.instrument_id, symbol: record.instrument_id ? symbol(record.instrument_id) : undefined,
        action: record.action, score: numeric(record.score), confidence: numeric(record.confidence), classification: record.classification,
        riskLevel: record.risk_level, reasons: record.reasons, positiveReasons: record.positive_reasons, mainRisks: record.main_risks,
        horizon: record.horizon, proposedAmountEur: numeric(record.estimated_amount_eur), proposedQuantity: numeric(record.proposed_quantity),
        review: record.decision_context?.review, components: record.decision_context?.components, decisionContext: record.decision_context })),
      executedTransactions: trades.map(trade => ({ ...trade, side: trade.side, symbol: symbol(trade.instrument_id), instrumentId: trade.instrument_id,
        amountEur: numeric(trade.gross_amount_eur), quantity: numeric(trade.quantity) })),
    };
  }
  async getEmailReport(runId) {
    return resultOrThrow(await this.table('dailyEmailReports').select('*').eq('run_id', runId).maybeSingle(), 'rapport email');
  }
  async enqueueEmail(runId, recipient, message) {
    await this.getCompletedRun(runId);
    // Conserver le contenu du premier rapport : UNIQUE(run_id), aucun remplacement.
    resultOrThrow(await this.table('dailyEmailReports').upsert({ run_id: runId, recipient,
      subject: message.subject, html_body: message.html, text_body: message.text },
    { onConflict: 'run_id', ignoreDuplicates: true }), 'outbox email');
    return this.getEmailReport(runId);
  }
  async claimEmail(runId) {
    await this.getCompletedRun(runId);
    // Mise à jour conditionnelle atomique : un seul appel gagne, jamais de reclaim.
    return resultOrThrow(await this.table('dailyEmailReports').update({ status: 'sending', attempt_count: 1 })
      .eq('run_id', runId).eq('status', 'pending').eq('attempt_count', 0).select('*').maybeSingle(), 'réservation email');
  }
  async completeEmail(runId, providerMessageId = null) {
    resultOrThrow(await this.table('dailyEmailReports').update({ status: 'sent', sent_at: new Date().toISOString(),
      provider_message_id: providerMessageId, error_message: null }).eq('run_id', runId).eq('status', 'sending'), 'email envoyé');
  }
  async failEmail(runId) {
    resultOrThrow(await this.table('dailyEmailReports').update({ status: 'failed', error_message: 'EMAIL_DELIVERY_FAILED; ne pas retenter automatiquement.' })
      .eq('run_id', runId).eq('status', 'sending'), 'échec email');
  }
}
