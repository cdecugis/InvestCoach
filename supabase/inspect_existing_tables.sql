-- LECTURE SEULE : exécuter dans le SQL Editor du projet kqgfeusiwvycpuvecgab
-- AVANT les migrations. Ne lit aucune ligne métier, aucune clé et aucun secret.
-- Les noms legacy sont des candidats à examiner, pas une preuve de propriété.
with expected(legacy_name, target_name) as (
  values
    ('instruments', 'invest_assets'),
    ('daily_prices', 'invest_market_prices'),
    ('fx_rates', 'invest_fx_rates'),
    ('benchmarks', 'invest_benchmarks'),
    ('benchmark_prices', 'invest_benchmark_prices'),
    ('portfolios', 'invest_portfolio'),
    ('daily_runs', 'invest_daily_runs'),
    ('indicator_snapshots', 'invest_daily_metrics'),
    ('investment_scores', 'invest_daily_scores'),
    ('positions', 'invest_positions'),
    ('recommendations', 'invest_recommendations'),
    ('paper_transactions', 'invest_transactions'),
    ('portfolio_snapshots', 'invest_portfolio_daily'),
    ('daily_email_reports', 'invest_daily_email_reports'),
    (null, 'invest_news')
)
select
  n.nspname as schema_name,
  c.relname as relation_name,
  c.relkind as relation_kind,
  c.relrowsecurity as rls_enabled,
  obj_description(c.oid, 'pg_class') as table_comment,
  exists (select 1 from expected e where e.legacy_name = c.relname) as legacy_candidate,
  exists (select 1 from expected e where e.target_name = c.relname) as target_name_collision,
  coalesce((select jsonb_agg(jsonb_build_object('name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
    from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::jsonb) as columns,
  coalesce((select jsonb_agg(pg_get_constraintdef(con.oid) order by con.conname)
    from pg_constraint con where con.conrelid = c.oid), '[]'::jsonb) as constraints
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by c.relname;

-- Vérifier aussi les collisions possibles sur les noms d'index.
select schemaname, tablename, indexname
from pg_indexes
where schemaname = 'public' and left(indexname, 7) = 'invest_'
order by tablename, indexname;
