import test from 'node:test';
import assert from 'node:assert/strict';
import { runEmailTestReport } from '../scripts/email-test-report.js';
import { InvestmentRepository } from '../src/db/investmentRepository.js';
import { TABLES } from '../src/db/supabase.js';
import { buildDailyReport } from '../src/modules/email/report.js';
import { renderDailyEmail } from '../src/modules/email/index.js';

const env = { EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'gmail-smtp',
  EMAIL_FROM: 'Coach Invest <coach@example.com>', EMAIL_TO: 'first@example.com; second@example.com, first@example.com' };
const source = {
  runId: 'finalized-run', date: '2026-10-07', status: 'already_completed',
  portfolio: { totalValueEur: 1010, cashEur: 750, positions: [] },
  performance: { cumulativeReturn: .01 },
  benchmark: { name: 'MSCI World', cumulativeReturn: .02, priceDate: '2026-10-07' },
  recommendations: [{ instrumentId: 'amd', symbol: 'AMD', action: 'NO_ACTION', score: 63,
    classification: 'SPECULATIVE', riskLevel: 'VERY_HIGH', confidence: .8,
    positiveReasons: ['Momentum fort'], mainRisks: ['Volatilité élevée'],
    components: { momentum1m: { weight: 80, score: 78.75 }, catalysts: { weight: 20, score: null } },
    decisionContext: { strategy: { signals: { buyScore: 75 } } } }],
  executedTransactions: [],
};

test('test manuel : rendu quotidien intégral, SMTP unique, aucune mutation ni outbox', async () => {
  const logs = [], errors = [], messages = [];
  let reads = 0;
  const repository = new Proxy({}, { get(_target, name) {
    assert.equal(name, 'getLatestCompletedReport', 'seule la lecture du rapport est autorisée');
    return async () => { reads++; return structuredClone(source); };
  } });
  const before = structuredClone(source);
  const result = await runEmailTestReport({ env, repositoryFactory: () => repository,
    transportFactory: (settings, _providers, dependencies) => {
      assert.equal(settings.provider, 'gmail-smtp');
      assert.equal(dependencies.env, env);
      return { send: async message => { messages.push(message); return { messageId: 'mock-id' }; } };
    }, log: value => logs.push(value), logError: value => errors.push(value) });
  assert.equal(result, 0);
  assert.equal(reads, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(source, before);
  const expected = renderDailyEmail(buildDailyReport(source));
  assert.equal(messages[0].html, expected.html);
  assert.equal(messages[0].text, expected.text);
  assert.equal(messages[0].subject, 'InvestCoach — test rapport complet — 2026-10-07');
  assert.deepEqual(messages[0].to, ['first@example.com', 'second@example.com']);
  for (const text of ['ACTION DU JOUR', 'AUCUNE OPÉRATION', '1010.00 EUR', '750.00 EUR',
    'Performance cumulée', 'MSCI World', 'BUY', 'SELL', 'HOLD', 'TOP 5 WATCH',
    '63.0 / technical 78.8', '80 %', 'SPECULATIVE', 'TRÈS ÉLEVÉ', 'Momentum fort',
    'Volatilité élevée', 'Facteurs manquants : catalysts', '12 points']) {
    assert.ok(messages[0].text.includes(text), text);
  }
  assert.ok(logs.some(value => value.includes('manual test report')));
  assert.deepEqual(errors, []);
});

test('EMAIL_ENABLED=false : aucune lecture DB ni connexion SMTP', async () => {
  const errors = [];
  const forbidden = () => { assert.fail('aucun appel autorisé'); };
  assert.equal(await runEmailTestReport({ env: { EMAIL_ENABLED: 'false' }, repositoryFactory: forbidden,
    transportFactory: forbidden, log() {}, logError: value => errors.push(value) }), 1);
  assert.equal(errors[0].code, 'EMAIL_DISABLED');
});

test('aucun rapport finalisé : erreur explicite et aucun envoi', async () => {
  const errors = [];
  assert.equal(await runEmailTestReport({ env,
    repositoryFactory: () => ({ async getLatestCompletedReport() {
      throw Object.assign(new Error('NO_FINALIZED_REPORT_AVAILABLE'), { code: 'NO_FINALIZED_REPORT_AVAILABLE' });
    } }), transportFactory: () => ({ send() { assert.fail('aucun envoi'); } }),
    log() {}, logError: value => errors.push(value) }), 1);
  assert.equal(errors[0].code, 'NO_FINALIZED_REPORT_AVAILABLE');
});

test('échec SMTP : une seule tentative, aucune écriture et logs sans secrets', async () => {
  let attempts = 0;
  const errors = [];
  const settings = { ...env, SMTP_PASSWORD: 'dummy-private-password', SUPABASE_SECRET_KEY: 'dummy-private-key' };
  assert.equal(await runEmailTestReport({ env: settings,
    repositoryFactory: () => ({ async getLatestCompletedReport() { return structuredClone(source); } }),
    transportFactory: () => ({ async send() {
      attempts++;
      throw Object.assign(new Error(`${settings.SMTP_PASSWORD} ${settings.SUPABASE_SECRET_KEY}`), { code: 'EAUTH' });
    } }), log() {}, logError: value => errors.push(value) }), 1);
  assert.equal(attempts, 1);
  assert.equal(errors[0].code, 'EAUTH');
  assert.ok(!JSON.stringify(errors).includes(settings.SMTP_PASSWORD));
  assert.ok(!JSON.stringify(errors).includes(settings.SUPABASE_SECRET_KEY));
});

for (const found of [true, false]) {
  test(`sélection en lecture seule du dernier run completed du bon portefeuille : trouvé=${found}`, async () => {
    const calls = [];
    const query = {
      select(value) { calls.push(['select', value]); return this; },
      eq(key, value) { calls.push(['eq', key, value]); return this; },
      order(key, options) { calls.push(['order', key, options]); return this; },
      limit(value) { calls.push(['limit', value]); return this; },
      async maybeSingle() { return { data: found ? { id: 'latest' } : null, error: null }; },
    };
    const repository = new InvestmentRepository({ from(table) { assert.equal(table, TABLES.dailyRuns); return query; } });
    repository.getPortfolio = async () => ({ id: 'investment-portfolio' });
    repository.getCompletedReport = async id => { assert.equal(id, 'latest'); return source; };
    if (found) assert.equal(await repository.getLatestCompletedReport(), source);
    else await assert.rejects(repository.getLatestCompletedReport(), { code: 'NO_FINALIZED_REPORT_AVAILABLE' });
    assert.deepEqual(calls, [['select', 'id'], ['eq', 'portfolio_id', 'investment-portfolio'],
      ['eq', 'status', 'completed'], ['order', 'run_date', { ascending: false }], ['limit', 1]]);
  });
}
