import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getInvestmentTable, getSupabase, TABLES } from '../src/db/supabase.js';

const initial = readFileSync(new URL('../supabase/migrations/001_initial_schema.sql', import.meta.url), 'utf8');
const aggressive = readFileSync(new URL('../supabase/migrations/002_aggressive_profile.sql', import.meta.url), 'utf8');

test('SQL : toutes les créations et références sont invest_*, sans commande destructive', () => {
  const created = [...initial.matchAll(/create table public\.(\w+)/g)].map(match => match[1]);
  assert.deepEqual(created.sort(), Object.values(TABLES).sort());
  for (const sql of [initial, aggressive]) {
    assert.doesNotMatch(sql, /\b(?:drop|truncate)\s+(?:table|schema|constraint|column)|\bdelete\s+from|\bupdate\s+public\./i);
    for (const reference of sql.matchAll(/(?:references|alter table|create table|insert into|on table|on column) public\.(\w+)/gi)) {
      assert.ok(reference[1].startsWith('invest_'));
    }
  }
  assert.ok(initial.indexOf('raise exception') < initial.indexOf('create table'));
  assert.match(aggressive, /obj_description/);
  assert.match(initial, /enable row level security/);
  assert.doesNotMatch(initial + aggressive, /disable row level security|create policy|alter default privileges/i);
  const secured = initial.slice(initial.indexOf('foreach table_name'));
  for (const name of created) assert.ok(secured.includes(`'${name}'`), `${name} doit recevoir RLS`);
});

test('backend : noms autorisés, projet ciblé, clé publique refusée et secret uniquement dans le mock réseau', async () => {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  const fixtureSecret = 'sb_secret_' + 'not_a_real_key_fixture';
  let requested;
  try {
    assert.throws(() => getInvestmentTable('customers'), /inconnue/);
    delete process.env.SUPABASE_SECRET_KEY;
    assert.throws(getSupabase, /nécessaires/);
    process.env.SUPABASE_URL = 'https://wrong-project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = fixtureSecret;
    assert.throws(getSupabase, /projet existant/);
    process.env.SUPABASE_URL = 'https://kqgfeusiwvycpuvecgab.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_publishable_not_a_real_key';
    assert.throws(getSupabase, /jamais une clé publique/);
    process.env.SUPABASE_SECRET_KEY = fixtureSecret;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_unused_fixture';
    globalThis.fetch = async (url, options) => {
      requested = { url: String(url), headers: new Headers(options.headers) };
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { error } = await getInvestmentTable('recommendations').select('id').limit(1);
    assert.equal(error, null);
    assert.ok(requested.url.startsWith('https://kqgfeusiwvycpuvecgab.supabase.co/rest/v1/invest_recommendations?'));
    assert.equal(requested.headers.get('apikey'), fixtureSecret);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test('PAPER_TRADING=false ou invalide bloque le démarrage', async () => {
  const previous = process.env.PAPER_TRADING;
  try {
    for (const value of ['false', '0', '']) {
      process.env.PAPER_TRADING = value;
      await assert.rejects(import(`../src/config/env.js?paper-guard=${encodeURIComponent(value)}`), /PAPER_TRADING doit rester true/);
    }
    process.env.PAPER_TRADING = 'true';
    assert.equal((await import('../src/config/env.js?paper-enabled')).config.paperTrading, true);
  } finally {
    if (previous === undefined) delete process.env.PAPER_TRADING;
    else process.env.PAPER_TRADING = previous;
  }
});
