-- Après 001 et 002 : ajouts nécessaires au job, exclusivement sur invest_*.
-- Aucun effacement de données. Deux contraintes et un index sont remplacés
-- pour autoriser NO_ACTION par actif et l'exécution d'un signal de la veille.
begin;
do $$
declare table_name text;
begin
  perform pg_advisory_xact_lock(hashtext('InvestmentAdvisor:invest:schema'));
  foreach table_name in array array['invest_assets','invest_market_prices','invest_fx_rates',
    'invest_benchmarks','invest_benchmark_prices','invest_daily_metrics','invest_daily_scores',
    'invest_portfolio','invest_positions','invest_daily_runs','invest_recommendations',
    'invest_transactions','invest_portfolio_daily'] loop
    if obj_description(to_regclass(format('public.%I', table_name)), 'pg_class')
      is distinct from 'InvestmentAdvisor:invest:v1' then
      raise exception 'Migration 003 arrêtée : public.% absent ou non identifié InvestmentAdvisor.', table_name;
    end if;
  end loop;
  if to_regprocedure('public.invest_acquire_daily_run(uuid,date)') is not null then
    raise exception 'Migration 003 déjà installée ; ne pas la rejouer.';
  end if;
end $$;

alter table public.invest_market_prices
  add column asset_id uuid generated always as (instrument_id) stored,
  add column date date generated always as (price_date) stored,
  add column open numeric(24,10) check (open > 0),
  add column high numeric(24,10) check (high > 0),
  add column low numeric(24,10) check (low > 0),
  add column is_final boolean not null default true,
  add column dividend numeric(24,10),
  add column split_ratio numeric(24,10) check (split_ratio > 0),
  add constraint invest_market_prices_asset_date_key unique (asset_id, date);
alter table public.invest_fx_rates add column open_eur_per_unit numeric(24,12) check (open_eur_per_unit > 0);
alter table public.invest_daily_metrics
  add column return_5d numeric(18,10), add column return_6m numeric(18,10),
  add column ma20 numeric(24,10) generated always as (sma_20) stored,
  add column ma50 numeric(24,10) generated always as (sma_50) stored,
  add column rsi14 numeric(8,4) generated always as (rsi_14) stored,
  add column ma200 numeric(24,10) check (ma200 > 0),
  add column volatility20 numeric(18,10) check (volatility20 >= 0),
  add column volatility60 numeric(18,10) check (volatility60 >= 0),
  add column volume_ratio numeric(18,10) check (volume_ratio >= 0),
  add column distance_52w_high numeric(18,10), add column drawdown_52w numeric(18,10) check (drawdown_52w <= 0);
-- Clôture conservée sans supprimer de ligne ni changer les contraintes qty>0.
alter table public.invest_positions add column closed_at timestamptz;
alter table public.invest_daily_runs add column lease_token uuid;
alter table public.invest_recommendations drop constraint invest_recommendations_check;
alter table public.invest_recommendations add constraint invest_recommendations_instrument_action_check
  check (action = 'NO_ACTION' or instrument_id is not null);
drop index public.invest_recommendations_no_action_per_run;
create unique index invest_recommendations_no_action_per_run on public.invest_recommendations(run_id)
  where action = 'NO_ACTION' and instrument_id is null;
alter table public.invest_transactions add column recommendation_run_id uuid;
update public.invest_transactions set recommendation_run_id = run_id;
alter table public.invest_transactions alter column recommendation_run_id set not null;
alter table public.invest_transactions drop constraint invest_transactions_recommendation_id_run_id_fkey;
alter table public.invest_transactions add constraint invest_transactions_source_recommendation_fkey
  foreign key (recommendation_id, recommendation_run_id) references public.invest_recommendations(id, run_id);

create function public.invest_acquire_daily_run(p_portfolio_id uuid, p_run_date date)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare r public.invest_daily_runs%rowtype;
begin
  if p_run_date <> (now() at time zone 'Europe/Paris')::date then raise exception 'Date de run incorrecte.'; end if;
  perform 1 from public.invest_portfolio where id = p_portfolio_id and trading_mode = 'paper' for update;
  if not found then raise exception 'Portefeuille paper introuvable.'; end if;
  insert into public.invest_daily_runs(portfolio_id,run_date) values(p_portfolio_id,p_run_date)
    on conflict(portfolio_id,run_date) do nothing;
  select * into strict r from public.invest_daily_runs where portfolio_id=p_portfolio_id and run_date=p_run_date for update;
  if r.status='completed' then return jsonb_build_object('id',r.id,'status','completed'); end if;
  if r.status='running' and r.lease_until > now() then raise exception 'Run déjà en cours.'; end if;
  update public.invest_daily_runs set status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '20 minutes',attempt_count=attempt_count+1,started_at=now(),error_message=null
    where id=r.id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'leaseToken',r.lease_token);
end $$;

create function public.invest_heartbeat(p_run_id uuid,p_lease_token uuid)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update public.invest_daily_runs set lease_until=now()+interval '20 minutes'
    where id=p_run_id and lease_token=p_lease_token and status='running' and lease_until>now();
  if not found then raise exception 'Lease perdue.'; end if;
end $$;

create function public.invest_execute_paper_trade(p_run_id uuid,p_lease_token uuid,p_recommendation_id uuid,p_fees_eur numeric)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  r public.invest_daily_runs%rowtype; p public.invest_portfolio%rowtype;
  rec public.invest_recommendations%rowtype; pos public.invest_positions%rowtype;
  bar public.invest_market_prices%rowtype; asset public.invest_assets%rowtype;
  prior public.invest_transactions%rowtype;
  fx numeric; fx_day date; qty numeric; gross numeric; debit numeric; cost_released numeric;
  total_value numeric; exposure numeric:=0; target_value numeric:=0; slots integer;
  last_score numeric; significant boolean:=false; v record; v_rate numeric; v_date date; last_day date;
begin
  select * into strict r from public.invest_daily_runs where id=p_run_id;
  select * into strict p from public.invest_portfolio where id=r.portfolio_id for update;
  select * into strict r from public.invest_daily_runs where id=p_run_id for update;
  if r.status<>'running' or r.lease_token is distinct from p_lease_token or r.lease_until<=now()
    or r.run_date<>(now() at time zone 'Europe/Paris')::date or p.trading_mode<>'paper' then
    raise exception 'Exécution refusée : run ou mode paper invalide.';
  end if;
  select * into strict rec from public.invest_recommendations where id=p_recommendation_id for update;
  if exists(select 1 from public.invest_transactions where recommendation_id=rec.id) then
    return jsonb_build_object('status','already_executed','recommendationId',rec.id);
  end if;
  if not exists(select 1 from public.invest_daily_runs where id=rec.run_id and portfolio_id=p.id and status='completed'
    and run_date>=(rec.decision_context->>'signalDate')::date)
    or rec.status<>'proposed' or rec.action not in ('BUY','SELL')
    or (select run_date from public.invest_daily_runs where id=rec.run_id)>=r.run_date
    or rec.decision_context->>'signalDate' is null
    or (rec.decision_context->>'signalDate')::date>=r.run_date then raise exception 'Signal non exécutable à la séance suivante.'; end if;
  if rec.score is null or rec.confidence<coalesce((rec.decision_context#>>'{strategy,signals,minConfidence}')::numeric,0.8) or rec.confidence is null
    or (rec.action='BUY' and rec.score<coalesce((rec.decision_context#>>'{strategy,signals,buyScore}')::numeric,75))
    or (rec.action='SELL' and rec.score>coalesce((rec.decision_context#>>'{strategy,signals,sellScore}')::numeric,40)) then raise exception 'Signal insuffisant.'; end if;
  if p_fees_eur is null or p_fees_eur<0 or p_fees_eur<>round(p_fees_eur,2) then raise exception 'Frais invalides.'; end if;
  select count(*) into slots from public.invest_transactions where portfolio_id=p.id and trade_date=r.run_date;
  if slots>=least(p.max_daily_trades,2) then raise exception 'Deux transactions quotidiennes maximum.'; end if;
  select * into strict asset from public.invest_assets where id=rec.instrument_id;
  if rec.action='BUY' and not asset.enabled then raise exception 'Actif désactivé.'; end if;
  select * into strict bar from public.invest_market_prices where instrument_id=asset.id and price_date=r.run_date and is_final;
  if bar.open is null then raise exception 'Ouverture de séance indisponible.'; end if;
  -- Une proposition manquée expire ; ne pas simuler après une séance intermédiaire.
  if exists(select 1 from public.invest_market_prices where instrument_id=asset.id and is_final
    and price_date>(rec.decision_context->>'signalDate')::date and price_date<r.run_date) then raise exception 'Signal expiré.'; end if;
  if asset.currency='EUR' then fx:=1;fx_day:=r.run_date;
  else select open_eur_per_unit,rate_date into fx,fx_day from public.invest_fx_rates
    where currency=asset.currency and rate_date<=r.run_date order by rate_date desc limit 1;
  end if;
  if fx is null or r.run_date-fx_day>4 then raise exception 'FX ouverture indisponible.'; end if;
  select * into pos from public.invest_positions where portfolio_id=p.id and instrument_id=asset.id and closed_at is null;
  select * into prior from public.invest_transactions where portfolio_id=p.id and instrument_id=asset.id order by executed_at desc,id desc limit 1;
  if prior.id is not null and r.run_date-prior.trade_date<p.cooldown_days then
    select score into last_score from public.invest_recommendations where id=prior.recommendation_id;
    significant:=case when rec.action='BUY' then rec.score-last_score>=coalesce((rec.decision_context#>>'{strategy,cooldown,significantScoreChange}')::numeric,15)
      else last_score-rec.score>=coalesce((rec.decision_context#>>'{strategy,cooldown,significantScoreChange}')::numeric,15) end;
    significant:=coalesce(significant,false) or exists(
      select 1 from jsonb_array_elements(coalesce(rec.decision_context->'catalysts','[]'::jsonb)) evidence
      where length(btrim(evidence->>'source'))>0 and length(btrim(evidence->>'description'))>0
        and evidence->>'type' in (select jsonb_array_elements_text(rec.decision_context#>'{strategy,evidence,catalystTypes}'))
        and (evidence->>'date')::date>prior.trade_date and (evidence->>'date')::date<r.run_date
        and r.run_date-(evidence->>'date')::date<=coalesce((rec.decision_context#>>'{strategy,evidence,maxAgeDays}')::integer,30)
        and (case when rec.action='BUY' then 1 else -1 end)*(evidence->>'strength')::numeric
          between coalesce((rec.decision_context#>>'{strategy,cooldown,significantCatalystStrength}')::numeric,0.7) and 1);
    if not coalesce(significant,false) then raise exception 'Cooldown actif.'; end if;
  end if;
  -- Valorisation à l'ouverture du jour : aucune clôture future pour dimensionner.
  for v in select ps.*,a.currency from public.invest_positions ps join public.invest_assets a on a.id=ps.instrument_id
    where ps.portfolio_id=p.id and ps.closed_at is null loop
    select open,price_date into v_rate,v_date from public.invest_market_prices where instrument_id=v.instrument_id
      and price_date=r.run_date and is_final;
    if v_rate is null then
      select close,price_date into v_rate,v_date from public.invest_market_prices where instrument_id=v.instrument_id
        and price_date<r.run_date and is_final order by price_date desc limit 1;
    end if;
    if v_date is null or r.run_date-v_date>4 then raise exception 'Position non valorisable.'; end if;
    if v.currency<>'EUR' then
      select open_eur_per_unit,rate_date into cost_released,last_day from public.invest_fx_rates where currency=v.currency
        and rate_date<=v_date order by rate_date desc limit 1;
      if cost_released is null or v_date-last_day>4 then raise exception 'FX position absent ou ancien.'; end if;
      v_rate:=v_rate*cost_released;
    end if;
    exposure:=exposure+v.quantity*v_rate;
    if v.instrument_id=asset.id then target_value:=v.quantity*v_rate; end if;
  end loop;
  total_value:=p.cash_eur+exposure;
  if rec.action='BUY' then
    if pos.instrument_id is null and (select count(*) from public.invest_positions where portfolio_id=p.id and closed_at is null)>=least(p.max_positions,4)
      then raise exception 'Quatre positions maximum.'; end if;
    qty:=floor(least(rec.estimated_amount_eur,p.cash_eur-p_fees_eur,
      1000-p.invested_cost_eur-p_fees_eur,1000-exposure,
      least(p.max_position_weight,0.35)*(total_value-p_fees_eur)-target_value)/(bar.open*fx)*100000000)/100000000;
    gross:=round(qty*bar.open*fx,6); debit:=gross+p_fees_eur;
    if qty<=0 or gross<greatest(p.min_order_eur,100) or debit>p.cash_eur
      or p.invested_cost_eur+debit>1000 or exposure+gross>1000
      or target_value+gross>least(p.max_position_weight,0.35)*(total_value-p_fees_eur) then raise exception 'Achat hors limites.'; end if;
    insert into public.invest_positions(portfolio_id,instrument_id,quantity,cost_basis_eur)
      values(p.id,asset.id,qty,debit) on conflict(portfolio_id,instrument_id) do update
      set quantity=case when invest_positions.closed_at is null then invest_positions.quantity+qty else qty end,
          cost_basis_eur=case when invest_positions.closed_at is null then invest_positions.cost_basis_eur+debit else debit end,
          closed_at=null,updated_at=now();
    update public.invest_portfolio set cash_eur=cash_eur-debit,invested_cost_eur=invested_cost_eur+debit,updated_at=now() where id=p.id;
  else
    if pos.instrument_id is null then raise exception 'Vente à découvert interdite.'; end if;
    qty:=least(rec.proposed_quantity,pos.quantity);gross:=round(qty*bar.open*fx,6);
    if qty<=0 or (gross<greatest(p.min_order_eur,100) and qty<>pos.quantity) or p.cash_eur+gross<p_fees_eur then raise exception 'Vente hors limites.'; end if;
    cost_released:=case when qty=pos.quantity then pos.cost_basis_eur else round(pos.cost_basis_eur*qty/pos.quantity,6) end;
    if qty=pos.quantity then update public.invest_positions set closed_at=now(),updated_at=now() where portfolio_id=p.id and instrument_id=asset.id;
    else update public.invest_positions set quantity=quantity-qty,cost_basis_eur=cost_basis_eur-cost_released,updated_at=now() where portfolio_id=p.id and instrument_id=asset.id; end if;
    update public.invest_portfolio set cash_eur=cash_eur+gross-p_fees_eur,invested_cost_eur=invested_cost_eur-cost_released,updated_at=now() where id=p.id;
  end if;
  insert into public.invest_transactions(portfolio_id,instrument_id,run_id,recommendation_id,recommendation_run_id,
    trade_date,daily_slot,side,quantity,price_date,price_native,currency,fx_date,fx_eur_per_unit,gross_amount_eur,fees_eur)
    values(p.id,asset.id,r.id,rec.id,rec.run_id,r.run_date,slots+1,rec.action,qty,r.run_date,bar.open,asset.currency,fx_day,fx,gross,p_fees_eur);
  update public.invest_recommendations set status='executed' where id=rec.id;
  return jsonb_build_object('status','executed','side',rec.action,'instrumentId',asset.id,'quantity',qty,'amountEur',gross);
end $$;

create function public.invest_finish_daily_run(p_run_id uuid,p_lease_token uuid,p_snapshot jsonb,p_benchmark_id uuid)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
declare r public.invest_daily_runs%rowtype;p public.invest_portfolio%rowtype;
  v record; last_price numeric; price_day date; fx numeric; fx_day date; expected_value numeric:=0;
begin
  select * into strict r from public.invest_daily_runs where id=p_run_id;
  select * into strict p from public.invest_portfolio where id=r.portfolio_id for update;
  select * into strict r from public.invest_daily_runs where id=p_run_id for update;
  if r.status<>'running' or r.lease_token is distinct from p_lease_token or r.lease_until<=now() then raise exception 'Lease perdue.'; end if;
  if abs(p.cash_eur-(p_snapshot->>'cash_eur')::numeric)>0.000001
    or abs(p.invested_cost_eur-(p_snapshot->>'invested_cost_eur')::numeric)>0.000001 then raise exception 'Snapshot incohérent.'; end if;
  if abs(p.invested_cost_eur-coalesce((select sum(cost_basis_eur) from public.invest_positions where portfolio_id=p.id and closed_at is null),0))>0.000001
    then raise exception 'Coûts des positions incohérents.'; end if;
  for v in select ps.*,a.currency from public.invest_positions ps join public.invest_assets a on a.id=ps.instrument_id
    where ps.portfolio_id=p.id and ps.closed_at is null loop
    select close,price_date into last_price,price_day from public.invest_market_prices where instrument_id=v.instrument_id
      and is_final and price_date<=r.run_date order by price_date desc limit 1;
    if last_price is null or r.run_date-price_day>4 then raise exception 'Valorisation finale impossible.'; end if;
    if v.currency='EUR' then fx:=1;
    else select eur_per_unit,rate_date into fx,fx_day from public.invest_fx_rates where currency=v.currency
      and rate_date<=price_day order by rate_date desc limit 1;
      if fx is null or price_day-fx_day>4 then raise exception 'FX final absent ou ancien.'; end if;
    end if;
    expected_value:=expected_value+round(v.quantity*last_price*fx,6);
  end loop;
  if abs(expected_value-(p_snapshot->>'positions_value_eur')::numeric)>0.000001
    or abs((p.cash_eur+expected_value)/p.initial_capital_eur-1-(p_snapshot->>'cumulative_return')::numeric)>0.000001
    then raise exception 'Performance finale incohérente.'; end if;
  if p.benchmark_base_level_eur is not null and p.benchmark_id is distinct from p_benchmark_id then raise exception 'Benchmark déjà initialisé : changement interdit.'; end if;
  if p.benchmark_base_level_eur is null and (p_snapshot->>'benchmark_level_eur') is not null then
    if exists(select 1 from public.invest_portfolio_daily where portfolio_id=p.id) then raise exception 'Base benchmark manquante : examen nécessaire.'; end if;
    update public.invest_portfolio set benchmark_id=p_benchmark_id,
      benchmark_base_date=(p_snapshot->>'benchmark_price_date')::date,
      benchmark_base_level_eur=(p_snapshot->>'benchmark_level_eur')::numeric,updated_at=now() where id=p.id;
  end if;
  insert into public.invest_portfolio_daily(portfolio_id,snapshot_date,run_id,cash_eur,invested_cost_eur,positions_value_eur,
    daily_return,cumulative_return,benchmark_level_eur,benchmark_price_date,benchmark_cumulative_return,excess_return,positions_detail,valuation_context)
  values(p.id,r.run_date,r.id,p.cash_eur,p.invested_cost_eur,(p_snapshot->>'positions_value_eur')::numeric,
    (p_snapshot->>'daily_return')::numeric,(p_snapshot->>'cumulative_return')::numeric,(p_snapshot->>'benchmark_level_eur')::numeric,
    (p_snapshot->>'benchmark_price_date')::date,(p_snapshot->>'benchmark_cumulative_return')::numeric,
    (p_snapshot->>'excess_return')::numeric,p_snapshot->'positions_detail',p_snapshot->'valuation_context')
  on conflict(portfolio_id,snapshot_date) do update set cash_eur=excluded.cash_eur,invested_cost_eur=excluded.invested_cost_eur,
    positions_value_eur=excluded.positions_value_eur,daily_return=excluded.daily_return,cumulative_return=excluded.cumulative_return,
    benchmark_level_eur=excluded.benchmark_level_eur,benchmark_price_date=excluded.benchmark_price_date,
    benchmark_cumulative_return=excluded.benchmark_cumulative_return,excess_return=excluded.excess_return,
    positions_detail=excluded.positions_detail,valuation_context=excluded.valuation_context;
  update public.invest_daily_runs set status='completed',completed_at=now(),lease_until=null,last_completed_step='performance' where id=r.id;
end $$;

revoke all on function public.invest_acquire_daily_run(uuid,date) from public,anon,authenticated;
revoke all on function public.invest_heartbeat(uuid,uuid) from public,anon,authenticated;
revoke all on function public.invest_execute_paper_trade(uuid,uuid,uuid,numeric) from public,anon,authenticated;
revoke all on function public.invest_finish_daily_run(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.invest_acquire_daily_run(uuid,date) to service_role;
grant execute on function public.invest_heartbeat(uuid,uuid) to service_role;
grant execute on function public.invest_execute_paper_trade(uuid,uuid,uuid,numeric) to service_role;
grant execute on function public.invest_finish_daily_run(uuid,uuid,jsonb,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
