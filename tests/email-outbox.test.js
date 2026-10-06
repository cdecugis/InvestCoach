import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { InvestmentRepository } from '../src/db/investmentRepository.js';
import { TABLES } from '../src/db/supabase.js';

// Adaptateur de test du sous-ensemble PostgREST utilisé par l'outbox : les
// contraintes et réservations s'exécutent réellement dans PostgreSQL/PGlite.
function client(db) {
  return { from(table) {
    assert.ok([TABLES.dailyRuns, TABLES.dailyEmailReports].includes(table));
    let operation = 'select', payload, conflict, filters = [], returning = false;
    const query = {
      select() { if (operation !== 'select') returning = true; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      update(value) { operation = 'update'; payload = value; return query; },
      upsert(value, options) {
        assert.equal(options.ignoreDuplicates, true);
        operation = 'insert'; payload = value; conflict = options.onConflict; return query;
      },
      async execute() {
        try {
          const params = [];
          const bind = value => { params.push(value); return `$${params.length}`; };
          const column = name => { assert.match(name, /^[a-z_]+$/); return `"${name}"`; };
          let sql;
          if (operation === 'insert') {
            sql = `insert into public.${table} (${Object.keys(payload).map(column).join(',')}) values (${Object.values(payload).map(bind).join(',')}) on conflict (${column(conflict)}) do nothing`;
          } else {
            sql = operation === 'update' ? `update public.${table} set ${Object.entries(payload).map(([key, value]) => `${column(key)}=${bind(value)}`).join(',')}`
              : `select * from public.${table}`;
            if (filters.length) sql += ` where ${filters.map(([key, value]) => `${column(key)}=${bind(value)}`).join(' and ')}`;
          }
          if (returning) sql += ' returning *';
          return { data: (await db.query(sql, params)).rows, error: null };
        } catch (error) { return { data: null, error }; }
      },
      then(resolve, reject) { return query.execute().then(resolve, reject); },
      async single() {
        const result = await query.execute();
        if (result.error) return result;
        return result.data.length === 1 ? { data: result.data[0], error: null } : { data: null, error: { message: 'Ligne unique absente' } };
      },
      async maybeSingle() {
        const result = await query.execute();
        return result.error ? result : { data: result.data[0] ?? null, error: null };
      },
    };
    return query;
  } };
}

test('rapport finalisé : snapshot et décisions relus sans recalcul, montants et composants restaurés', async () => {
  const snapshot = { cash_eur: '750', total_value_eur: '1010', invested_cost_eur: '250', positions_value_eur: '260',
    daily_return: '.01', cumulative_return: '.01', benchmark_cumulative_return: '.02', excess_return: '-.01',
    benchmark_price_date: '2026-10-06', positions_detail: [{ instrumentId: 'asset', symbol: 'AMD', marketValueEur: 260 }] };
  const repository = new InvestmentRepository({ from(table) {
    assert.equal(table, TABLES.portfolioDaily);
    return { select() { return this; }, eq(key, value) { assert.equal(key, 'run_id'); assert.equal(value, 'run'); return this; },
      async single() { return { data: snapshot, error: null }; } };
  } });
  repository.getCompletedRun = async () => ({ portfolio_id: 'portfolio', run_date: '2026-10-06', status: 'completed' });
  repository.getAssets = async () => [{ id: 'asset', provider_symbol: 'AMD' }];
  repository.getPortfolio = async () => ({ benchmark_id: 'benchmark' });
  repository.getBenchmark = async () => ({ name: 'MSCI World (proxy IWDA.AS)' });
  repository.all = async key => key === 'transactions' ? [{ instrument_id: 'asset', side: 'BUY', gross_amount_eur: '250', quantity: '2' }]
    : [{ instrument_id: 'asset', action: 'HOLD', score: '63', confidence: '.8', classification: 'CORE',
      positive_reasons: ['Momentum'], main_risks: [], reasons: [],
      decision_context: { components: { momentum1m: { weight: 20, score: 80 } } } }];
  const report = await repository.getCompletedReport('run');
  assert.equal(report.status, 'already_completed');
  assert.equal(report.portfolio.totalValueEur, 1010);
  assert.equal(report.performance.cumulativeReturn, .01);
  assert.equal(report.executedTransactions[0].amountEur, 250);
  assert.equal(report.executedTransactions[0].symbol, 'AMD');
  assert.equal(report.recommendations[0].score, 63);
  assert.equal(report.recommendations[0].components.momentum1m.score, 80);
});

test('outbox PostgreSQL : run finalisé obligatoire, contenu immuable, claim atomique et aucune seconde tentative', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for (const name of ['001_initial_schema.sql', '002_aggressive_profile.sql', '003_daily_analysis.sql']) {
      await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const portfolioId = (await db.query('select id from public.invest_portfolio')).rows[0].id;
    const completed = (await db.query("insert into public.invest_daily_runs(portfolio_id,run_date,status) values($1,'2026-10-06','completed') returning id", [portfolioId])).rows[0].id;
    const running = (await db.query("insert into public.invest_daily_runs(portfolio_id,run_date,status) values($1,'2026-10-07','running') returning id", [portfolioId])).rows[0].id;
    const repository = new InvestmentRepository(client(db));
    const message = { subject: 'Original', html: '<p>Original</p>', text: 'Original' };
    await assert.rejects(repository.enqueueEmail(running, 'reader@example.test', message), /run finalisé/);
    await repository.enqueueEmail(completed, 'reader@example.test', message);
    await repository.enqueueEmail(completed, 'different@example.test', { ...message, subject: 'Changed' });
    const original = await repository.getEmailReport(completed);
    assert.equal(original.subject, 'Original');
    assert.equal(original.recipient, 'reader@example.test');
    const claims = await Promise.all([repository.claimEmail(completed), repository.claimEmail(completed)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await repository.getEmailReport(completed)).attempt_count, 1);
    await repository.completeEmail(completed, 'provider-id');
    assert.equal((await repository.getEmailReport(completed)).status, 'sent');
    assert.equal(await repository.claimEmail(completed), null);
    await repository.enqueueEmail(completed, 'reader@example.test', message);
    assert.equal((await repository.getEmailReport(completed)).status, 'sent');
    await db.query("update public.invest_daily_runs set status='completed' where id=$1", [running]);
    await repository.enqueueEmail(running, 'reader@example.test', message);
    await repository.claimEmail(running);
    await repository.failEmail(running);
    assert.equal(await repository.claimEmail(running), null);
    assert.equal((await repository.getCompletedRun(running)).status, 'completed');
    await db.exec('set role anon;');
    await assert.rejects(db.query('select * from public.invest_daily_email_reports'), /permission denied/);
  } finally { await db.close(); }
});
