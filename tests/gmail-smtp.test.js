import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipients, readEmailSettings, createEmailTransport } from '../src/modules/email/transport.js';
import { produceDailyReport } from '../src/modules/email/report.js';
import { runEmailTest } from '../scripts/email-test.js';
import { config } from '../src/config/env.js';

const fixturePassword = 'fixture_only_not_a_real_password';
const environment = overrides => ({ EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'gmail-smtp',
  EMAIL_FROM: 'Coach Invest <coach@example.test>', EMAIL_TO: 'one@example.test; two@example.test, one@example.test',
  SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'coach@example.test',
  SMTP_PASSWORD: fixturePassword, ...overrides });

function mockedTransport(env, sendMail = async () => ({ messageId: 'mock-id', accepted: ['one@example.test'] })) {
  let options, calls = 0, message;
  const transport = createEmailTransport(readEmailSettings(env), {}, { env, createTransport(value) {
    options = value;
    return { async sendMail(value) { calls++; message = value; return sendMail(value); } };
  } });
  return { transport, get options() { return options; }, get calls() { return calls; }, get message() { return message; } };
}
const mail = { from: 'ignored@example.test', to: 'one@example.test; two@example.test, one@example.test',
  subject: 'Test', text: 'Test', html: '<p>Test</p>' };

test('destinataires : virgules, points-virgules, vides, trim et doublons sans casse', () => {
  assert.deepEqual(parseRecipients(' a@example.test, b@example.test; ; A@example.test ,, c@example.test; '),
    ['a@example.test', 'b@example.test', 'c@example.test']);
  assert.deepEqual(parseRecipients(['a@example.test', ' b@example.test; a@example.test']), ['a@example.test', 'b@example.test']);
  assert.deepEqual(parseRecipients(' ; , '), []);
  assert.throws(() => parseRecipients('one@example.test\r\nBcc: other@example.test'), /saut de ligne/);
});

test('EMAIL_ENABLED=false : aucun client SMTP, aucune variable SMTP obligatoire', () => {
  const env = { EMAIL_ENABLED: 'false', EMAIL_PROVIDER: 'unknown' };
  assert.equal(createEmailTransport(readEmailSettings(env), {}, { env, createTransport() { throw new Error('Aucun client'); } }), null);
});

test('provider inconnu et toutes les variables manquantes : erreurs claires avant connexion', () => {
  const unknown = environment({ EMAIL_PROVIDER: 'unsupported' });
  assert.throws(() => mockedTransport(unknown), error => error.code === 'EMAIL_PROVIDER_UNSUPPORTED');
  for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM', 'EMAIL_TO', 'EMAIL_PROVIDER']) {
    const env = environment({ [name]: '' });
    let created = false;
    assert.throws(() => createEmailTransport(readEmailSettings(env), {}, { env, createTransport() { created = true; } }),
      error => error.name === 'EmailConfigurationError' && error.message.includes(name));
    assert.equal(created, false, name);
  }
});

test('SMTP 587 : secure=false, STARTTLS requis, auth depuis SMTP_PASSWORD et aucun logger', async () => {
  const f = mockedTransport(environment());
  assert.equal(f.options.host, 'smtp.gmail.com');
  assert.equal(f.options.port, 587);
  assert.equal(f.options.secure, false);
  assert.equal(f.options.requireTLS, true);
  assert.deepEqual(f.options.auth, { user: 'coach@example.test', pass: fixturePassword });
  assert.equal(f.options.logger, false);
  assert.equal(f.options.debug, false);
  assert.equal(f.options.pool, false);
  assert.doesNotMatch(JSON.stringify(f.transport), /fixture_only/);
  assert.deepEqual(await f.transport.send(mail), { messageId: 'mock-id' });
  assert.equal(f.calls, 1);
  assert.equal(f.message.from, 'Coach Invest <coach@example.test>');
  assert.deepEqual(f.message.to, ['one@example.test', 'two@example.test']);
  assert.equal(f.message.text, mail.text);
  assert.equal(f.message.html, mail.html);
});

test('port et booléens invalides : configuration refusée sans exposer de valeur', () => {
  for (const override of [{ SMTP_PORT: 'invalid' }, { SMTP_PORT: '0' }, { SMTP_SECURE: 'yes' }, { SMTP_SECURE: 'true' }]) {
    assert.throws(() => mockedTransport(environment(override)), error => error.code === 'EMAIL_CONFIGURATION_INVALID');
  }
  const f = mockedTransport(environment({ SMTP_PORT: '465', SMTP_SECURE: 'true' }));
  assert.equal(f.options.secure, true);
  assert.equal(f.options.requireTLS, false);
});

test('échec SMTP : message/code exploitables, mot de passe et encodages masqués, une tentative', async () => {
  const encoded = Buffer.from(`\0coach@example.test\0${fixturePassword}`).toString('base64');
  const f = mockedTransport(environment(), async () => {
    const error = new Error(`535 Authentication failed ${fixturePassword} ${encoded}`);
    error.code = 'EAUTH'; error.responseCode = 535;
    error.auth = { pass: fixturePassword };
    throw error;
  });
  await assert.rejects(f.transport.send(mail), error => {
    assert.equal(error.code, 'EAUTH');
    assert.equal(error.responseCode, 535);
    assert.match(error.message, /Authentication failed/);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, stack: error.stack }), /fixture_only|AHNv/);
    assert.ok(!error.message.includes(encoded));
    assert.equal(error.auth, undefined);
    return true;
  });
  assert.equal(f.calls, 1);
});

test('acceptation partielle : erreur explicite, aucun second appel SMTP', async () => {
  const f = mockedTransport(environment(), async () => ({ messageId: 'partial-id', accepted: ['one@example.test'], rejected: ['two@example.test'] }));
  await assert.rejects(f.transport.send(mail), error => error.code === 'EMAIL_PARTIAL_DELIVERY');
  assert.equal(f.calls, 1);
});

function outbox() {
  let row;
  return { get row() { return row; },
    async enqueueEmail(runId, recipient, message) {
      row ??= { run_id: runId, recipient, subject: message.subject, html_body: message.html, text_body: message.text, status: 'pending' };
      return { ...row };
    },
    async claimEmail() { if (row.status !== 'pending') return null; row.status = 'sending'; return { ...row }; },
    async getEmailReport() { return { ...row }; },
    async completeEmail() { row.status = 'sent'; },
    async failEmail() { row.status = 'failed'; },
    fail() { throw new Error('Le run ne doit pas être annulé'); },
  };
}
const dailyResult = () => ({ status: 'completed', date: '2026-10-06', runId: 'run', dryRun: false,
  portfolio: { cashEur: 1000, totalValueEur: 1000, positions: [] }, performance: { cumulativeReturn: 0 },
  recommendations: [], executedTransactions: [{ side: 'BUY', amountEur: 250 }] });

test('outbox + Gmail mocké : sent/failed sans double envoi ni annulation du run', async () => {
  for (const fail of [false, true]) {
    const env = environment();
    const f = mockedTransport(env, async () => { if (fail) throw Object.assign(new Error('SMTP unavailable'), { code: 'ETIMEDOUT' }); return { messageId: 'success-id' }; });
    const repository = outbox();
    const options = { settings: { ...config, email: readEmailSettings(env) }, repository, emailTransport: f.transport, logError: () => {} };
    const first = await produceDailyReport(dailyResult(), options);
    assert.equal(first.status, 'completed');
    assert.equal(first.executedTransactions.length, 1);
    assert.equal(first.emailSent, !fail);
    assert.equal(repository.row.status, fail ? 'failed' : 'sent');
    assert.equal(repository.row.recipient, 'one@example.test, two@example.test');
    assert.ok(!JSON.stringify(first).includes(fixturePassword));
    assert.ok(!JSON.stringify(repository.row).includes(fixturePassword));
    await produceDailyReport(dailyResult(), options);
    assert.equal(f.calls, 1);
    const disabled = await produceDailyReport(dailyResult(), { ...options, settings: { ...config, email: { ...options.settings.email, enabled: false } } });
    assert.equal(disabled.emailSent, false);
    assert.equal(f.calls, 1);
  }
});

test('email:test : même transport, sujet/texte demandés, succès sobre sans moteur', async () => {
  const env = environment();
  const output = [], errors = [];
  const f = mockedTransport(env);
  const status = await runEmailTest({ env, transportFactory(settings, providers, dependencies) {
    assert.deepEqual(settings, readEmailSettings(env));
    assert.equal(dependencies.env, env);
    return f.transport;
  }, log: value => output.push(value), logError: value => errors.push(value) });
  assert.equal(status, 0);
  assert.deepEqual(output, ['Email sent successfully']);
  assert.deepEqual(errors, []);
  assert.equal(f.message.subject, 'InvestCoach — test email');
  assert.equal(f.message.text, "Test d'envoi SMTP InvestmentAdvisor réussi.");
});

test('email:test : disabled/configuration/SMTP en erreur, sortie sans secret', async () => {
  const disabledErrors = [];
  const disabled = await runEmailTest({ env: { EMAIL_ENABLED: 'false' },
    transportFactory() { throw new Error('Connexion interdite'); }, logError: value => disabledErrors.push(value) });
  assert.equal(disabled, 1);
  assert.equal(disabledErrors[0].code, 'EMAIL_DISABLED');
  const env = environment({ SMTP_PASSWORD: '' });
  const missingErrors = [];
  assert.equal(await runEmailTest({ env, logError: value => missingErrors.push(value) }), 1);
  assert.match(missingErrors[0].message, /SMTP_PASSWORD/);
  const logs = [];
  assert.equal(await runEmailTest({ env: environment(), logError: value => logs.push(value),
    transportFactory() { return { async send() { throw Object.assign(new Error(`Failed ${fixturePassword}`), { code: 'EAUTH', responseCode: 535 }); } }; } }), 1);
  assert.equal(logs[0].code, 'EAUTH');
  assert.equal(logs[0].responseCode, 535);
  assert.ok(!JSON.stringify(logs).includes(fixturePassword));
});
