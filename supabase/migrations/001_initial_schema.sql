-- InvestmentAdvisor : initialisation invest_* dans le projet EXISTANT kqgfeusiwvycpuvecgab.
-- Examiner inspect_existing_tables.sql avant ce fichier ; ne pas rejouer les
-- migrations sur une base contenant déjà des tables InvestmentAdvisor.
-- Aucun ordre réel, aucun accès public. Les règles métier inter-tables devront
-- être validées par une RPC transactionnelle avant d'activer le pipeline.
begin;

-- Contrôle impératif AVANT toute création. Les noms legacy nécessitent une
-- inspection humaine : ils pourraient appartenir ? cette app ou ? une autre.
-- Une collision provoque une exception et annule la transaction complète.
do $$
declare collisions text;
begin
  perform pg_advisory_xact_lock(hashtext('InvestmentAdvisor:invest:schema'));
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by c.relname)
  into collisions
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (
    'instruments',
    'daily_prices',
    'fx_rates',
    'benchmarks',
    'benchmark_prices',
    'portfolios',
    'daily_runs',
    'indicator_snapshots',
    'investment_scores',
    'positions',
    'recommendations',
    'paper_transactions',
    'portfolio_snapshots',
    'daily_email_reports',
    'invest_assets',
    'invest_market_prices',
    'invest_fx_rates',
    'invest_benchmarks',
    'invest_benchmark_prices',
    'invest_portfolio',
    'invest_daily_runs',
    'invest_daily_metrics',
    'invest_daily_scores',
    'invest_positions',
    'invest_recommendations',
    'invest_transactions',
    'invest_portfolio_daily',
    'invest_daily_email_reports',
    'invest_news',
    'invest_recommendations_instrument_per_run',
    'invest_recommendations_no_action_per_run',
    'invest_transactions_history',
    'invest_daily_runs_status',
    'invest_news_asset_date'
  );
  if collisions is not null then
    raise exception 'Création InvestmentAdvisor arrêtée : objets existants %. Inspecter leur propriétaire et leur schéma ; aucune duplication ni migration automatique.', collisions;
  end if;
end $$;


create table public.invest_assets (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  exchange text not null,
  name text,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  region text not null check (region in ('EU', 'US')),
  provider_symbol text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (symbol, exchange)
);

create table public.invest_market_prices (
  instrument_id uuid not null references public.invest_assets(id),
  price_date date not null,
  close numeric(24,10) not null check (close > 0),
  adjusted_close numeric(24,10) check (adjusted_close > 0),
  volume numeric(24,4) check (volume >= 0),
  source text not null,
  adjustment_method text,
  fetched_at timestamptz not null default now(),
  primary key (instrument_id, price_date)
);
comment on column public.invest_market_prices.adjusted_close is
  'Base des indicateurs : splits/dividendes selon méthode du fournisseur. Ne pas exécuter sur ce prix.';

create table public.invest_fx_rates (
  rate_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  eur_per_unit numeric(24,12) not null check (eur_per_unit > 0),
  source text not null,
  fetched_at timestamptz not null default now(),
  primary key (rate_date, currency)
);

create table public.invest_benchmarks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('index', 'etf_proxy')),
  return_type text not null check (return_type in ('price', 'gross_total_return', 'net_total_return')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_symbol text,
  unique (name, kind, return_type, currency)
);

create table public.invest_benchmark_prices (
  benchmark_id uuid not null references public.invest_benchmarks(id),
  price_date date not null,
  level numeric(24,10) not null check (level > 0),
  source text not null,
  fetched_at timestamptz not null default now(),
  primary key (benchmark_id, price_date)
);

create table public.invest_portfolio (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  trading_mode text not null default 'paper' check (trading_mode = 'paper'),
  base_currency text not null default 'EUR' check (base_currency = 'EUR'),
  initial_capital_eur numeric(18,6) not null default 1000 check (initial_capital_eur = 1000),
  cash_eur numeric(18,6) not null default 1000 check (cash_eur >= 0),
  invested_cost_eur numeric(18,6) not null default 0 check (invested_cost_eur between 0 and 1000),
  max_position_weight numeric(5,4) not null default 0.35 check (max_position_weight > 0 and max_position_weight <= 0.35),
  max_daily_trades smallint not null default 2 check (max_daily_trades between 1 and 2),
  benchmark_id uuid references public.invest_benchmarks(id),
  benchmark_base_date date,
  benchmark_base_level_eur numeric(24,10) check (benchmark_base_level_eur > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((benchmark_base_date is null) = (benchmark_base_level_eur is null))
);

create table public.invest_daily_runs (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.invest_portfolio(id),
  run_date date not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  last_completed_step text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (portfolio_id, run_date),
  unique (id, portfolio_id, run_date)
);

create table public.invest_daily_metrics (
  instrument_id uuid not null references public.invest_assets(id),
  as_of_date date not null,
  last_price_date date not null,
  return_1m numeric(18,10),
  return_3m numeric(18,10),
  return_12m numeric(18,10),
  sma_20 numeric(24,10) check (sma_20 > 0),
  sma_50 numeric(24,10) check (sma_50 > 0),
  rsi_14 numeric(8,4) check (rsi_14 between 0 and 100),
  volatility_30 numeric(18,10) check (volatility_30 >= 0),
  history_complete boolean not null,
  diagnostics jsonb not null default '{}'::jsonb,
  calculation_version text not null,
  created_at timestamptz not null default now(),
  primary key (instrument_id, as_of_date),
  check (last_price_date <= as_of_date)
);

create table public.invest_daily_scores (
  instrument_id uuid not null,
  as_of_date date not null,
  score numeric(7,4) check (score between 0 and 100),
  components jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  model_version text not null,
  created_at timestamptz not null default now(),
  primary key (instrument_id, as_of_date),
  foreign key (instrument_id, as_of_date)
    references public.invest_daily_metrics(instrument_id, as_of_date)
);

create table public.invest_positions (
  portfolio_id uuid not null references public.invest_portfolio(id),
  instrument_id uuid not null references public.invest_assets(id),
  quantity numeric(24,10) not null check (quantity > 0),
  cost_basis_eur numeric(18,6) not null check (cost_basis_eur > 0),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (portfolio_id, instrument_id)
);

create table public.invest_recommendations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.invest_daily_runs(id),
  instrument_id uuid references public.invest_assets(id),
  action text not null check (action in ('BUY', 'HOLD', 'SELL', 'NO_ACTION')),
  score numeric(7,4) check (score between 0 and 100),
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) > 0),
  proposed_quantity numeric(24,10) check (proposed_quantity > 0),
  estimated_amount_eur numeric(18,6) check (estimated_amount_eur > 0),
  priority integer not null default 0,
  status text not null default 'proposed' check (status in ('proposed', 'executed', 'rejected', 'no_trade')),
  decision_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, run_id),
  check ((action = 'NO_ACTION' and instrument_id is null) or (action <> 'NO_ACTION' and instrument_id is not null)),
  check ((action in ('BUY', 'SELL') and proposed_quantity is not null and estimated_amount_eur is not null)
    or (action in ('HOLD', 'NO_ACTION') and proposed_quantity is null and estimated_amount_eur is null))
);
create unique index invest_recommendations_instrument_per_run
  on public.invest_recommendations(run_id, instrument_id) where instrument_id is not null;
create unique index invest_recommendations_no_action_per_run
  on public.invest_recommendations(run_id) where action = 'NO_ACTION';

create table public.invest_transactions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.invest_portfolio(id),
  instrument_id uuid not null references public.invest_assets(id),
  run_id uuid not null,
  recommendation_id uuid not null unique,
  trade_date date not null,
  daily_slot smallint not null check (daily_slot in (1, 2)),
  side text not null check (side in ('BUY', 'SELL')),
  quantity numeric(24,10) not null check (quantity > 0),
  price_date date not null,
  price_native numeric(24,10) not null check (price_native > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  fx_date date not null,
  fx_eur_per_unit numeric(24,12) not null check (fx_eur_per_unit > 0),
  gross_amount_eur numeric(18,6) not null check (gross_amount_eur > 0),
  fees_eur numeric(18,6) not null default 0 check (fees_eur >= 0),
  executed_at timestamptz not null default now(),
  unique (portfolio_id, trade_date, daily_slot),
  foreign key (run_id, portfolio_id, trade_date)
    references public.invest_daily_runs(id, portfolio_id, run_date),
  foreign key (recommendation_id, run_id) references public.invest_recommendations(id, run_id),
  check (price_date <= trade_date and fx_date <= trade_date)
);
comment on table public.invest_transactions is
  'Journal virtuel. Deux slots par jour. Future RPC obligatoire pour cohérence cash/invest_positions, side et montant.';

create table public.invest_portfolio_daily (
  portfolio_id uuid not null references public.invest_portfolio(id),
  snapshot_date date not null,
  run_id uuid not null unique,
  cash_eur numeric(18,6) not null check (cash_eur >= 0),
  invested_cost_eur numeric(18,6) not null check (invested_cost_eur between 0 and 1000),
  positions_value_eur numeric(18,6) not null check (positions_value_eur >= 0),
  total_value_eur numeric(18,6) generated always as (cash_eur + positions_value_eur) stored,
  daily_return numeric(18,10),
  cumulative_return numeric(18,10) not null,
  benchmark_level_eur numeric(24,10) check (benchmark_level_eur > 0),
  benchmark_price_date date,
  benchmark_cumulative_return numeric(18,10),
  excess_return numeric(18,10),
  positions_detail jsonb not null default '[]'::jsonb,
  valuation_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (portfolio_id, snapshot_date),
  foreign key (run_id, portfolio_id, snapshot_date)
    references public.invest_daily_runs(id, portfolio_id, run_date),
  check (benchmark_price_date is null or benchmark_price_date <= snapshot_date)
);

create table public.invest_daily_email_reports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.invest_daily_runs(id),
  recipient text not null,
  subject text not null,
  html_body text not null,
  text_body text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  provider_message_id text,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index invest_transactions_history on public.invest_transactions(portfolio_id, executed_at desc);
create index invest_daily_runs_status on public.invest_daily_runs(status, run_date);

create table public.invest_news (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.invest_assets(id),
  source text not null,
  source_event_id text not null,
  source_url text,
  event_type text not null,
  event_date date not null,
  published_at timestamptz not null,
  description text not null,
  strength numeric(6,4) check (strength between -1 and 1),
  payload jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  unique (instrument_id, source, source_event_id)
);
create index invest_news_asset_date on public.invest_news(instrument_id, event_date desc);

-- Backend uniquement : pas de politique permettant anon/authenticated.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'invest_assets', 'invest_market_prices', 'invest_fx_rates', 'invest_benchmarks', 'invest_benchmark_prices',
    'invest_portfolio', 'invest_daily_runs', 'invest_daily_metrics', 'invest_daily_scores',
    'invest_positions', 'invest_recommendations', 'invest_transactions', 'invest_portfolio_daily',
    'invest_daily_email_reports', 'invest_news'
  ] loop
    execute format('comment on table public.%I is %L', table_name, 'InvestmentAdvisor:invest:v1');
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

insert into public.invest_benchmarks (name, kind, return_type, currency)
values ('MSCI World', 'index', 'net_total_return', 'EUR');

insert into public.invest_portfolio (name, benchmark_id)
select 'InvestmentAdvisor', id from public.invest_benchmarks
where name = 'MSCI World' and kind = 'index' and return_type = 'net_total_return' and currency = 'EUR';

commit;
