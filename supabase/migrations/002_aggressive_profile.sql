-- Appliquer UNIQUEMENT après la nouvelle 001 invest_*, jamais sur les anciennes tables non préfixées.
-- La limite de 35 % est définie dès 001 : aucun remplacement de contrainte ni changement de données.
begin;

-- Aucune table préexistante d'une autre application ne doit être modifiée.
do $$
declare table_name text;
begin
  perform pg_advisory_xact_lock(hashtext('InvestmentAdvisor:invest:schema'));
  foreach table_name in array array['invest_portfolio', 'invest_daily_metrics', 'invest_daily_scores', 'invest_recommendations'] loop
    if to_regclass(format('public.%I', table_name)) is null
      or obj_description(to_regclass(format('public.%I', table_name)), 'pg_class') is distinct from 'InvestmentAdvisor:invest:v1' then
      raise exception 'Migration arrêtée : public.% absent ou sans marqueur InvestmentAdvisor. Inspecter la base ; aucun changement effectué.', table_name;
    end if;
  end loop;
end $$;


alter table public.invest_portfolio
  add column risk_profile text not null default 'AGGRESSIVE' check (risk_profile = 'AGGRESSIVE'),
  add column max_positions smallint not null default 4 check (max_positions between 1 and 4),
  add column min_order_eur numeric(18,6) not null default 100 check (min_order_eur >= 100),
  add column stop_review_pct numeric(8,4) not null default -18 check (stop_review_pct > -100 and stop_review_pct < 0),
  add column take_profit_review_pct numeric(8,4) not null default 25 check (take_profit_review_pct > 0),
  add column cooldown_days integer not null default 7 check (cooldown_days >= 1);

alter table public.invest_daily_metrics
  add column signal_features jsonb not null default '{}'::jsonb;
comment on column public.invest_daily_metrics.signal_features is
  'Facteurs AGGRESSIVE : rendements 5j, volume relatif, plus haut 60j, marché/secteur, résultats et catalyseurs datés/sourcés.';

alter table public.invest_daily_scores
  add column signal_context jsonb not null default '{}'::jsonb;
comment on column public.invest_daily_scores.signal_context is
  'Conserver confiance, risques, classification, catalyseurs, données manquantes et configuration effective du score.';

alter table public.invest_recommendations
  add column classification text check (classification in ('CORE', 'SPECULATIVE')),
  add column risk_level text check (risk_level in ('HIGH', 'VERY_HIGH')),
  add column confidence numeric(5,4) check (confidence between 0 and 1),
  add column positive_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(positive_reasons) = 'array'),
  add column main_risks jsonb not null default '[]'::jsonb check (jsonb_typeof(main_risks) = 'array'),
  add column horizon text;
comment on column public.invest_recommendations.decision_context is
  'Configuration, composants, review non automatique, cooldown, frais et candidats refusés. Score de cette recommandation à joindre aux transactions pour scoreAtTrade.';

-- Ces colonnes et limites paramètrent le futur moteur. Les contrôles agrégés
-- 4 positions / poids / cash nécessitent toujours une RPC SQL atomique.
-- Les anciens scores/recommandations restent inchangés et non reclassifiés.
commit;
