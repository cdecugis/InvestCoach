import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyJobHandler } from '../src/app.js';
import { errorLogEntry } from '../src/shared/error-log.js';

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
}
const clock = () => new Date('2026-10-06T21:30:00.000Z');

test('HTTP daily : réponse structurée et paramètres du client ignorés', async () => {
  let args;
  const recommendations = [{ instrumentId: 'a', symbol: 'AAPL', action: 'NO_ACTION', reasons: [] },
    { instrumentId: null, action: 'NO_ACTION', reasons: [] }];
  const handler = createDailyJobHandler(async (...input) => {
    args = input;
    return { status: 'completed', dryRun: true, date: '2026-10-06', recommendations, executedTransactions: [] };
  }, clock);
  const res = response();
  await handler({ body: { dryRun: false, paperTrading: false }, query: { dryRun: 'false' } }, res);
  assert.deepEqual(args, []);
  assert.equal(res.body.assetsProcessed, 1);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.paperTrading, true);
  assert.equal(res.body.startTime, clock().toISOString());
  assert.equal(res.body.endTime, clock().toISOString());
  assert.deepEqual(res.body.recommendations, recommendations);
  assert.deepEqual(res.body.transactions, []);
  assert.deepEqual(res.body.errors, []);
});

test('HTTP daily : analyse déjà terminée et erreur partielle explicite', async () => {
  const res = response();
  await createDailyJobHandler(async () => ({ status: 'already_completed', dryRun: false }), clock)({}, res);
  assert.equal(res.body.assetsProcessed, 0);
  assert.deepEqual(res.body.recommendations, []);
  const partial = response();
  await createDailyJobHandler(async () => ({ status: 'completed', dryRun: true,
    recommendations: [{ instrumentId: 'a', symbol: 'AAPL', reasons: ['Source indisponible : timeout'] }] }), clock)({}, partial);
  assert.equal(partial.body.errors[0].code, 'MARKET_DATA_UNAVAILABLE');
});

test('HTTP daily : échec structuré sans fuite de secret ni bilan partiel inventé', async () => {
  const logs = [];
  const res = response();
  await createDailyJobHandler(async () => { throw new Error('sb_secret_NEVER_EXPOSE'); }, clock,
    entry => logs.push(entry))({}, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'INTERNAL_ERROR' });
  assert.equal(logs[0].event, 'request_failed');
  assert.equal(logs[0].name, 'Error');
  assert.ok(logs[0].message);
  assert.ok(logs[0].stack);
  assert.doesNotMatch(JSON.stringify({ body: res.body, logs }), /NEVER_EXPOSE/);
});

test('logs : détails SQL et cause conservés, credentials imbriqués et dans le texte masqués', () => {
  const cause = new Error('Connexion refusée');
  cause.code = 'ECONNREFUSED';
  const error = new Error('Échec Supabase token=PRIVATE_TOKEN Authorization: Bearer PRIVATE_AUTH', { cause });
  error.code = '23505';
  error.details = { constraint: 'invest_prices_unique', credentials: { password: 'PRIVATE_PASSWORD' },
    headers: { Authorization: 'PRIVATE_HEADER' }, url: 'https://alice:PRIVATE_URL@example.com?api_key=PRIVATE_KEY' };
  error.hint = 'Vérifier la contrainte';
  const entry = errorLogEntry('request_failed', error);
  assert.equal(entry.code, '23505');
  assert.equal(entry.cause.code, 'ECONNREFUSED');
  assert.equal(entry.details.constraint, 'invest_prices_unique');
  assert.equal(entry.hint, 'Vérifier la contrainte');
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_|alice/);
});

test('logs : exception non Error, cycles et secret environnement sans exécuter de getter', () => {
  const saved = process.env.TEST_LOG_SECRET;
  process.env.TEST_LOG_SECRET = 'PRIVATE_ENV_VALUE';
  try {
    const error = { message: 'Échec PRIVATE_ENV_VALUE', code: 'PGRST202', details: 'RPC introuvable' };
    error.self = error;
    Object.defineProperty(error, 'credentials', { enumerable: true, get() { throw new Error('Getter interdit'); } });
    const entry = errorLogEntry('request_failed', error);
    assert.equal(entry.code, 'PGRST202');
    assert.equal(entry.value.self, '[Circular]');
    assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_ENV_VALUE|Getter interdit/);
    assert.equal(errorLogEntry('request_failed', null).value, null);
  } finally {
    if (saved === undefined) delete process.env.TEST_LOG_SECRET;
    else process.env.TEST_LOG_SECRET = saved;
  }
});
