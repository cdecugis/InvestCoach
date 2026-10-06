import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';
import { buildDailySummary, enrichRecommendation } from '../src/modules/email/summary.js';
import { buildDailyReport, produceDailyReport } from '../src/modules/email/report.js';
import { renderDailyEmail, sendDailyEmail } from '../src/modules/email/index.js';
import { createEmailTransport } from '../src/modules/email/transport.js';
import { runDailyJob } from '../src/jobs/daily-job.js';

function recommendation(symbol = 'AMD', score = 63, action = 'NO_ACTION') {
  return { instrumentId: symbol, symbol, action, score, confidence: .8, classification: 'CORE', riskLevel: 'HIGH',
    positiveReasons: ['Momentum confirmé'], mainRisks: ['Risque événementiel non évalué'], reasons: ['Signal insuffisant'],
    proposedAmountEur: ['BUY', 'SELL'].includes(action) ? 250 : null, proposedQuantity: ['BUY', 'SELL'].includes(action) ? 2 : null,
    components: Object.fromEntries(Object.entries(config.strategy.weights).map(([name, weight]) => [name,
      { weight, score: ['relativeSector', 'growthResults', 'catalysts'].includes(name) ? null : score / .8 }])) };
}
function result(overrides = {}) {
  return { status: 'completed', date: '2026-10-06', runId: 'run', dryRun: false,
    portfolio: { cashEur: 1000, totalValueEur: 1000, positions: [] }, performance: { cumulativeReturn: 0 },
    benchmark: { name: 'MSCI World (proxy IWDA.AS)', cumulativeReturn: 0, priceDate: '2026-10-06' },
    recommendations: [recommendation(), { instrumentId: null, action: 'NO_ACTION' }], executedTransactions: [], ...overrides };
}
function settings(enabled = true, overrides = {}) {
  return { ...config, email: { enabled, to: 'reader@example.test', from: 'advisor@example.test', provider: '', ...overrides } };
}
function outboxFixture(source = result()) {
  let row = null, sends = 0, claims = 0;
  const repository = {
    async getCompletedReport() { return { ...source, status: 'already_completed' }; },
    async enqueueEmail(runId, recipient, message) {
      row ??= { run_id: runId, recipient, subject: message.subject, html_body: message.html, text_body: message.text, status: 'pending', attempt_count: 0 };
      return { ...row };
    },
    async claimEmail() {
      if (row.status !== 'pending' || row.attempt_count !== 0) return null;
      row.status = 'sending'; row.attempt_count = 1; claims++;
      return { ...row };
    },
    async getEmailReport() { return { ...row }; },
    async completeEmail() { row.status = 'sent'; },
    async failEmail() { row.status = 'failed'; },
    fail() { throw new Error('Ne jamais modifier le run après sa finalisation'); },
  };
  const transport = { async send(message, context) {
    sends++;
    assert.equal(context.idempotencyKey, 'investmentadvisor:run');
    assert.equal(message.to, 'reader@example.test');
    return { messageId: 'provider-id' };
  } };
  return { repository, transport, get row() { return row; }, get sends() { return sends; }, get claims() { return claims; } };
}
const noLog = () => {};

test('présentation : 63 réel, technique 78.8, couverture 80 ; aucune mutation de décision', () => {
  const original = recommendation();
  const before = structuredClone(original);
  const record = enrichRecommendation(original);
  assert.equal(record.finalScore, 63);
  assert.equal(record.score, 63);
  assert.equal(record.technicalScore, 78.8);
  assert.equal(record.dataCoveragePct, 80);
  assert.equal(record.action, 'NO_ACTION');
  assert.equal(record.gapToBuy, 12);
  assert.deepEqual(record.missingFactors, ['relativeSector', 'growthResults', 'catalysts']);
  assert.deepEqual(original, before);
  assert.equal(enrichRecommendation({ score: null, components: {} }).technicalScore, null);
  const zero = enrichRecommendation({ score: 0, components: { available: { score: 0, weight: 20 }, absent: { score: null, weight: 80 } } });
  assert.equal(zero.technicalScore, 0);
  assert.equal(zero.dataCoveragePct, 20);
});

test('WATCH : cinq meilleurs NO_ACTION sous BUY, tri stable, global exclu et décisions inchangées', () => {
  const input = ['Z', 'A', 'B', 'C', 'D', 'E', 'F'].map((symbol, i) => recommendation(symbol, i < 2 ? 65 : 64-i));
  input.push(recommendation('BLOCKED', 79), recommendation('BUY', 80, 'BUY'), recommendation('HOLD', 50, 'HOLD'),
    recommendation('SELL', 20, 'SELL'), { instrumentId: null, action: 'NO_ACTION', score: 100 });
  const before = structuredClone(input);
  const summary = buildDailySummary(input);
  assert.equal(summary.watch.length, 5);
  assert.deepEqual(summary.watch.slice(0, 2).map(record => record.symbol), ['A', 'Z']);
  assert.ok(summary.watch.every(record => record.action === 'NO_ACTION' && record.score < 75));
  assert.equal(summary.noActionCount, 8);
  assert.equal(summary.holds.length, 1);
  assert.equal(summary.actionRequired, true);
  assert.match(summary.headline, /ACHETER BUY.*VENDRE SELL/);
  assert.deepEqual(input, before);
});

test('email : action visible en premier, portefeuille et WATCH compact, HTML échappé', () => {
  const source = result({ recommendations: [recommendation('AMD'), recommendation('PLTR', 54), recommendation('META', 53.2)] });
  const report = buildDailyReport(source);
  const email = renderDailyEmail(report);
  assert.ok(email.text.startsWith('ACTION DU JOUR\nAUCUNE OPÉRATION AUJOURD’HUI'));
  for (const label of ['1000.00 EUR', 'MSCI World', 'Actions BUY', 'Actions SELL', 'Positions HOLD', 'TOP 5 WATCH',
    'AMD — 63.0 / technical 78.8', 'PLTR — 54.0 / technical 67.5', 'META — 53.2 / technical 66.5', 'Facteurs manquants']) {
    assert.ok(email.text.includes(label), label);
  }
  const buy = recommendation('<script>', 76, 'BUY');
  const buyEmail = renderDailyEmail(buildDailyReport(result({ recommendations: [buy] })));
  assert.ok(buyEmail.text.includes('ACHETER <script> — 250.00 EUR'));
  assert.ok(buyEmail.text.includes('quantité : 2'));
  assert.ok(buyEmail.text.includes('Seuils de réévaluation'));
  assert.ok(!buyEmail.html.includes('<script>'));
});

test('DRY_RUN et EMAIL_ENABLED=false : rendu présent, aucune livraison', async () => {
  const dry = await produceDailyReport(result({ dryRun: true }), { settings: settings(),
    repository: new Proxy({}, { get() { throw new Error('Aucune écriture/lecture outbox en dry-run'); } }),
    emailTransport: { send() { throw new Error('Aucun envoi'); } } });
  assert.equal(dry.emailRendered, true);
  assert.equal(dry.emailSent, false);
  assert.equal(dry.emailStatus, 'dry_run');
  const f = outboxFixture();
  const disabled = await produceDailyReport(result(), { settings: settings(false), repository: f.repository, emailTransport: f.transport });
  assert.equal(disabled.emailRendered, true);
  assert.equal(disabled.emailSent, false);
  assert.equal(disabled.emailStatus, 'disabled');
  assert.equal(f.row.status, 'pending');
  assert.equal(f.sends, 0);
  assert.equal(f.claims, 0);
  assert.deepEqual(await sendDailyEmail({}, { enabled: false, transport: f.transport }), { sent: false });
});

test('aucun fournisseur choisi : outbox pending et erreur de configuration, run toujours completed', async () => {
  const f = outboxFixture();
  const report = await produceDailyReport(result(), { settings: settings(), repository: f.repository, logError: noLog });
  assert.equal(report.status, 'completed');
  assert.equal(report.emailRendered, true);
  assert.equal(report.emailSent, false);
  assert.equal(report.emailStatus, 'not_configured');
  assert.equal(report.errors[0].code, 'EMAIL_PROVIDER_NOT_CONFIGURED');
  assert.equal(f.claims, 0);
  assert.equal(f.row.attempt_count, 0);
  assert.throws(() => createEmailTransport(settings().email), /EMAIL_PROVIDER_NOT_CONFIGURED/);
});

test('envoi après retour du moteur finalisé, outbox et doublons concurrents', async () => {
  const f = outboxFixture();
  let finalized = false, analysisCalls = 0;
  const options = { settings: settings(), repository: f.repository, emailTransport: {
    async send(...args) { assert.equal(finalized, true); return f.transport.send(...args); },
  }, analysis: async () => { analysisCalls++; finalized = true; return result(); } };
  const report = await runDailyJob(options);
  assert.equal(analysisCalls, 1);
  assert.equal(report.emailSent, true);
  assert.equal(f.row.status, 'sent');
  const repeated = await produceDailyReport({ status: 'already_completed', runId: 'run', dryRun: false }, options);
  assert.equal(repeated.status, 'already_completed');
  assert.equal(repeated.summary.watch[0].symbol, 'AMD');
  assert.equal(repeated.emailSent, true);
  assert.equal(f.sends, 1);
  const concurrent = outboxFixture();
  await Promise.all([1, 2].map(() => produceDailyReport(result(), { settings: settings(), repository: concurrent.repository, emailTransport: concurrent.transport })));
  assert.equal(concurrent.sends, 1);
  assert.equal(concurrent.claims, 1);
});

test('panne transport : aucune annulation/reanalyse ; aucun nouvel envoi après failed', async () => {
  const f = outboxFixture();
  let sends = 0, analysisCalls = 0;
  const options = { settings: settings(), repository: f.repository, logError: noLog,
    emailTransport: { async send() { sends++; throw new Error('provider unavailable'); } },
    analysis: async () => { analysisCalls++; return result({ executedTransactions: [{ side: 'BUY', instrumentId: 'AMD', amountEur: 250 }] }); } };
  const report = await runDailyJob(options);
  assert.equal(report.status, 'completed');
  assert.equal(report.executedTransactions.length, 1);
  assert.equal(report.emailRendered, true);
  assert.equal(report.emailSent, false);
  assert.equal(report.emailStatus, 'failed');
  assert.equal(analysisCalls, 1);
  await produceDailyReport(result(), options);
  assert.equal(sends, 1);
  assert.equal(f.row.attempt_count, 1);
});

test('email livré mais confirmation DB perdue : pas de nouvel envoi', async () => {
  const f = outboxFixture();
  f.repository.completeEmail = async () => { throw new Error('DB unavailable'); };
  const options = { settings: settings(), repository: f.repository, emailTransport: f.transport, logError: noLog };
  const report = await produceDailyReport(result(), options);
  assert.equal(report.status, 'completed');
  assert.equal(report.emailSent, true);
  assert.equal(report.emailStatus, 'sent_unconfirmed');
  assert.equal(f.row.status, 'sending');
  await produceDailyReport(result(), options);
  assert.equal(f.sends, 1);
});

test('erreur du moteur : aucun rendu/envoi/outbox ; erreur de lecture du rapport finalisé isolée', async () => {
  await assert.rejects(runDailyJob({ analysis: async () => { throw new Error('analysis failed'); },
    repository: new Proxy({}, { get() { throw new Error('outbox interdit'); } }) }), /analysis failed/);
  const report = await produceDailyReport({ status: 'already_completed', runId: 'run', dryRun: false }, {
    repository: { async getCompletedReport() { throw new Error('snapshot absent'); } }, logError: noLog,
  });
  assert.equal(report.status, 'already_completed');
  assert.equal(report.summary.available, false);
  assert.equal(report.emailRendered, false);
});
