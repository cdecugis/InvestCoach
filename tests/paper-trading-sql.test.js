import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../src/config/env.js';

const migrations = ['001_initial_schema.sql','002_aggressive_profile.sql','003_daily_analysis.sql']
  .map(name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url),'utf8'));

async function fixture() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table public.games(marker text); insert into public.games values (\'untouched\');');
  for (const migration of migrations) await db.exec(migration);
  const portfolio = (await db.query('select * from public.invest_portfolio')).rows[0];
  const today = (await db.query("select (now() at time zone 'Europe/Paris')::date as date")).rows[0].date;
  const yesterday = (await db.query("select ((now() at time zone 'Europe/Paris')::date-1) as date")).rows[0].date;
  const oldRun = (await db.query("insert into public.invest_daily_runs(portfolio_id,run_date,status) values($1,$2,'completed') returning id",[portfolio.id,yesterday])).rows[0].id;
  const run = (await db.query('select public.invest_acquire_daily_run($1,$2) as run',[portfolio.id,today])).rows[0].run;
  const assets = [];
  for (let index=0;index<5;index+=1) {
    const asset = (await db.query("insert into public.invest_assets(symbol,exchange,currency,region) values($1,'XPAR','EUR','EU') returning id",[`TEST${index}`])).rows[0];
    await db.query("insert into public.invest_market_prices(instrument_id,price_date,open,high,low,close,adjusted_close,volume,source) values($1,$2,10,11,9,10,10,10000,'fixture')",[asset.id,today]);
    assets.push(asset.id);
  }
  async function order(assetIndex, {side='BUY', score=80, amount=350, quantity=35, sourceRun=oldRun, signalDate=yesterday}={}) {
    return (await db.query("insert into public.invest_recommendations(run_id,instrument_id,action,score,confidence,reasons,proposed_quantity,estimated_amount_eur,decision_context) values($1,$2,$3,$4,0.8,'[\"fixture signal\"]',$5,$6,$7) returning id",
      [sourceRun,assets[assetIndex],side,score,quantity,amount,JSON.stringify({signalDate,strategy:config.strategy})])).rows[0].id;
  }
  async function execute(id, fees=0, token=run.leaseToken) {
    return (await db.query('select public.invest_execute_paper_trade($1,$2,$3,$4) as result',[run.id,token,id,fees])).rows[0].result;
  }
  return {db,portfolio,run,today,yesterday,assets,oldRun,order,execute};
}

test('RPC : transactions atomiques, relecture idempotente, deux transactions et données étrangères intactes', async () => {
  const f=await fixture();
  try {
    const first=await f.order(0);
    assert.equal((await f.execute(first)).status,'executed');
    assert.equal((await f.execute(first)).status,'already_executed');
    assert.equal((await f.execute(await f.order(1))).status,'executed');
    await assert.rejects(f.execute(await f.order(2)),/Deux transactions/);
    const portfolio=(await f.db.query('select cash_eur,invested_cost_eur from public.invest_portfolio')).rows[0];
    assert.equal(Number(portfolio.cash_eur),300);
    assert.equal(Number(portfolio.invested_cost_eur),700);
    assert.equal((await f.db.query('select count(*) as count from public.invest_transactions')).rows[0].count,2);
    assert.equal((await f.db.query('select marker from public.games')).rows[0].marker,'untouched');
  } finally { await f.db.close(); }
});

test('RPC : quatre positions, cash insuffisant et montant minimum sans modification partielle', async () => {
  const f=await fixture();
  try {
    for (let index=0;index<4;index+=1) await f.db.query('insert into public.invest_positions(portfolio_id,instrument_id,quantity,cost_basis_eur) values($1,$2,20,200)',[f.portfolio.id,f.assets[index]]);
    await f.db.query('update public.invest_portfolio set cash_eur=200,invested_cost_eur=800 where id=$1',[f.portfolio.id]);
    await assert.rejects(f.execute(await f.order(4)),/Quatre positions/);
    await f.db.query('update public.invest_portfolio set cash_eur=50 where id=$1',[f.portfolio.id]);
    await assert.rejects(f.execute(await f.order(0)),/Achat hors limites/);
    assert.equal((await f.db.query('select count(*) as count from public.invest_transactions')).rows[0].count,0);
    assert.equal(Number((await f.db.query('select cash_eur from public.invest_portfolio')).rows[0].cash_eur),50);
  } finally { await f.db.close(); }
});

test('RPC : taille de position recalculée au prix d’ouverture, maximum 35 %', async () => {
  const f=await fixture();
  try {
    const result=await f.execute(await f.order(0,{amount:800,quantity:80}));
    assert.equal(Number(result.amountEur),350);
    assert.equal(Number(result.quantity),35);
  } finally { await f.db.close(); }
});

test('RPC : pas de signal du jour, pas de lease invalide et aucun accès anon', async () => {
  const f=await fixture();
  try {
    const sameDay=await f.order(0,{sourceRun:f.run.id,signalDate:f.today});
    await assert.rejects(f.execute(sameDay),/séance suivante/);
    const queued=await f.order(1);
    await assert.rejects(f.execute(queued,0,'00000000-0000-0000-0000-000000000000'),/run ou mode/);
    await f.db.exec('set role anon;');
    await assert.rejects(f.db.query('select public.invest_acquire_daily_run($1,$2)',[f.portfolio.id,f.today]),/permission denied/);
    await f.db.exec('reset role;');
  } finally { await f.db.close(); }
});

test('RPC : clôture d’une position conservée en base sans suppression de ligne', async () => {
  const f=await fixture();
  try {
    await f.db.query('insert into public.invest_positions(portfolio_id,instrument_id,quantity,cost_basis_eur) values($1,$2,30,300)',[f.portfolio.id,f.assets[0]]);
    await f.db.query('update public.invest_portfolio set cash_eur=700,invested_cost_eur=300 where id=$1',[f.portfolio.id]);
    const sale=await f.order(0,{side:'SELL',score:30,amount:300,quantity:30});
    assert.equal((await f.execute(sale)).status,'executed');
    const row=(await f.db.query('select quantity,closed_at from public.invest_positions')).rows[0];
    assert.equal(Number(row.quantity),30);
    assert.ok(row.closed_at);
    assert.equal(Number((await f.db.query('select cash_eur from public.invest_portfolio')).rows[0].cash_eur),1000);
  } finally { await f.db.close(); }
});

test('RPC : NO_ACTION par actif, alias asset_id/date et uniqueness des cours', async () => {
  const f=await fixture();
  try {
    for (const asset of f.assets) await f.db.query("insert into public.invest_recommendations(run_id,instrument_id,action,reasons) values($1,$2,'NO_ACTION','[\"no signal\"]')",[f.run.id,asset]);
    await f.db.query("insert into public.invest_recommendations(run_id,action,reasons) values($1,'NO_ACTION','[\"no trade\"]')",[f.run.id]);
    await f.db.query("insert into public.invest_market_prices(instrument_id,price_date,open,high,low,close,source) values($1,$2,11,12,10,11,'fixture') on conflict(asset_id,date) do update set close=excluded.close",[f.assets[0],f.today]);
    assert.equal((await f.db.query('select count(*) as count from public.invest_market_prices where asset_id=$1',[f.assets[0]])).rows[0].count,1);
    assert.equal(Number((await f.db.query('select close from public.invest_market_prices where asset_id=$1',[f.assets[0]])).rows[0].close),11);
  } finally { await f.db.close(); }
});

test('RPC : cooldown bloque une répétition, puis autorise une détérioration significative', async () => {
  const f=await fixture();
  try {
    const older=(await f.db.query("insert into public.invest_daily_runs(portfolio_id,run_date,status) values($1,$2::date-1,'completed') returning id",[f.portfolio.id,f.yesterday])).rows[0].id;
    const olderDate=(await f.db.query('select $1::date-1 as date',[f.yesterday])).rows[0].date;
    const historical=await f.order(0,{side:'SELL',score:35,quantity:10,amount:100,sourceRun:older,signalDate:olderDate});
    await f.db.query("insert into public.invest_transactions(portfolio_id,instrument_id,run_id,recommendation_id,recommendation_run_id,trade_date,daily_slot,side,quantity,price_date,price_native,currency,fx_date,fx_eur_per_unit,gross_amount_eur,fees_eur) values($1,$2,$3,$4,$5,$6,1,'SELL',10,$6,10,'EUR',$6,1,100,0)",
      [f.portfolio.id,f.assets[0],f.oldRun,historical,older,f.yesterday]);
    await f.db.query('insert into public.invest_positions(portfolio_id,instrument_id,quantity,cost_basis_eur) values($1,$2,30,300)',[f.portfolio.id,f.assets[0]]);
    await f.db.query('update public.invest_portfolio set cash_eur=700,invested_cost_eur=300 where id=$1',[f.portfolio.id]);
    const order=await f.order(0,{side:'SELL',score:30,quantity:30,amount:300});
    await assert.rejects(f.execute(order),/Cooldown actif/);
    await f.db.query('update public.invest_recommendations set score=15 where id=$1',[order]);
    assert.equal((await f.execute(order)).status,'executed');
  } finally { await f.db.close(); }
});

test('RPC : snapshot cohérent et finalisation atomique empêchent une seconde analyse du jour', async () => {
  const f=await fixture();
  try {
    await f.execute(await f.order(0));
    const snapshot={cash_eur:650,invested_cost_eur:350,positions_value_eur:350,daily_return:0,cumulative_return:0,
      benchmark_level_eur:100,benchmark_price_date:f.today,benchmark_cumulative_return:0,excess_return:0,
      positions_detail:[{instrumentId:f.assets[0],quantity:35,marketValueEur:350}],valuation_context:{source:'fixture'}};
    const finish=value => f.db.query('select public.invest_finish_daily_run($1,$2,$3,$4)',
      [f.run.id,f.run.leaseToken,JSON.stringify(value),f.portfolio.benchmark_id]);
    await assert.rejects(finish({...snapshot,positions_value_eur:349}),/Performance finale incohérente/);
    await finish(snapshot);
    const next=(await f.db.query('select public.invest_acquire_daily_run($1,$2) as run',[f.portfolio.id,f.today])).rows[0].run;
    assert.equal(next.status,'completed');
    const saved=(await f.db.query('select * from public.invest_portfolio_daily')).rows[0];
    assert.equal(Number(saved.total_value_eur),1000);
    assert.equal(Number((await f.db.query('select benchmark_base_level_eur from public.invest_portfolio')).rows[0].benchmark_base_level_eur),100);
  } finally { await f.db.close(); }
});
