# InvestmentAdvisor
Conseiller personnel Node.js en **paper trading exclusivement**, capital initial de **1 000 EUR**, profil **AGGRESSIVE**. Le job quotidien récupère les cours Yahoo, calcule les indicateurs/scores, analyse le portefeuille et peut simuler les ordres de la séance suivante via des RPC PostgreSQL atomiques. Il produit ensuite une synthèse et un email HTML/texte. L'architecture et les règles de décision existantes sont conservées. Le transport Gmail SMTP est disponible via Nodemailer, désactivé par défaut. L'analyse OpenAI des news reste déconnectée.
## Démarrage local
Prérequis : Node.js 24 LTS et npm. Le projet Supabase existant est **kqgfeusiwvycpuvecgab** ; son [dashboard](https://supabase.com/dashboard/project/kqgfeusiwvycpuvecgab) et sa base seront réutilisés. Aucun nouveau projet n'est nécessaire.
```powershell
npm ci
Copy-Item .env.example .env
npm run check
npm test
npm run dev
```
Ne pas écraser un `.env` existant. Renseigner ensuite les identifiants Supabase et les paramètres des fournisseurs dans `.env`. Le serveur écoute sur `0.0.0.0:8080` par défaut ; le contrôle de santé ne nécessite aucune connexion externe.
```powershell
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod -Method Post http://localhost:8080/jobs/daily
```
`GET /health` répond `200` avec `dailyJobImplemented: true` et le mode `dryRun`. `POST /jobs/daily` exécute le même job que la CLI, selon `DRY_RUN`. Le contrôle de santé confirme seulement que le serveur fonctionne, pas la connexion Supabase. `PAPER_TRADING=true` est obligatoire (défaut vrai pour compatibilité) ; toute autre valeur bloque le démarrage. `TRADING_MODE=PAPER_TRADING` et l'alias historique `paper` restent acceptés, avec stockage `paper` en base. Tout mode réel est refusé.
## Lancer l'analyse quotidienne
Le `.env` existant conserve ses credentials. `.env.example` a été recréé sans aucune clé réelle. Les valeurs par défaut sont Yahoo, IWDA.AS et **DRY_RUN=true**.
```powershell
cd C:\Users\Chris\Documents\InvestCoach
npm ci
npm test
npm run daily
# Forcer la lecture seule indépendamment du .env :
npm run daily -- --dry-run
```
Le dry-run exige la clé Supabase serveur pour **lire le vrai portefeuille**, récupère les données, calcule les indicateurs/scores et affiche les recommandations. Il n'effectue **aucune écriture Supabase**, y compris dans les actifs, cours, métriques, scores, recommandations, runs, snapshots ou outbox. Il génère le rendu email en mémoire et l'affiche dans la CLI, sans envoi ni transaction. Il fonctionne avant l'installation de 003 sur une base ayant déjà reçu 001/002.
Pour enregistrer les analyses et activer les transactions exclusivement virtuelles : appliquer **uniquement** `supabase/migrations/003_daily_analysis.sql` dans le SQL Editor du projet existant (001/002 sont déjà installées), puis :
```powershell
npm run daily -- --execute-paper
```
Ou définir `DRY_RUN=false` dans `.env` et utiliser `npm run daily`. L'option CLI explicite prend priorité sur `.env`. Ne pas écraser `.env` avec le fichier exemple.
Le premier run écrit les nouveaux signaux ; il ne les exécute pas rétroactivement. Un BUY/SELL proposé après clôture peut être simulé à **l'ouverture de la séance suivante**, lorsque sa bougie quotidienne est complète. Le run du jour booke cette ouverture et valorise ensuite les positions à la clôture. Les signaux manqués sont rejetés, pas exécutés à une ancienne ouverture. Un jour férié n'est pas une séance. L'exécution utilise le prix brut d'ouverture et le taux FX d'ouverture connu, sans utiliser la clôture pour dimensionner un achat. Les limites sont revalidées au prix d'ouverture ; un ordre peut être réduit ou refusé.
Exécuter le mode paper après clôture des marchés de la watchlist +15 minutes (par exemple 23 h 30 Europe/Paris). Une bougie de séance encore ouverte bloque le run paper ; le dry-run utilise uniquement les dernières séances clôturées. Une date déjà finalisée renvoie `already_completed`, sans rejouer de transaction. Un run échoué peut reprendre : les UUID de recommandations sont conservés et un signal ne peut être exécuté qu'une fois.
Variables de cette étape :
| Variable | Défaut | Utilisation |
| --- | --- | --- |
| `MARKET_DATA_PROVIDER` | `yahoo` | Adaptateur de données |
| `MARKET_DATA_API_KEY` | vide | Réservé aux futurs fournisseurs ; Yahoo n'en utilise pas |
| `BENCHMARK_PROVIDER_SYMBOL` | `IWDA.AS` | Proxy ETF MSCI World |
| `HISTORY_LOOKBACK_DAYS` | `550` | Historique rechargé chaque jour, y compris ajustements révisés |
| `MARKET_TIMEOUT_MS` | `15000` | Timeout réseau par appel |
| `MARKET_RETRIES` | `3` | Nombre maximal de tentatives |
| `MARKET_DELAY_MS` | `250` | Pause entre appels pour limiter le débit |
| `MAX_PRICE_AGE_DAYS` | `4` | Ancienneté maximale des cours/FX en jours calendaires |
| `DRY_RUN` | `true` | Lecture seule intégrale |
| `PAPER_FEE_EUR` | `0` | Frais fixes virtuels par transaction, au centime |
Les taux FX journaliers sont des cotations observées : la séance Forex 24 h du jour peut encore être ouverte. Le cours du jour sert à la valorisation, son ouverture à la simulation des ordres. Les taux et leurs dates sont conservés dans le journal. Les EUR n'exigent pas d'appel FX ; USD utilise l'inverse d'EURUSD=X ; GBP/GBX sont normalisés par l'adaptateur.
Extrait du dry-run réel du 6 octobre 2026 (cours et scores peuvent évoluer) :
```text
[MARKET] 2026-10-06 yahoo — DRY_RUN, aucune écriture
[MARKET] AAPL 378 lignes récupérées, clôture 2026-10-06
[INDICATORS] AAPL MA200=289.41 RSI14=54.6 ; 0 indicateurs absents
[SCORING] AAPL 37.1716/100 CORE, couverture 80 %, absents=relativeSector,growthResults,catalysts
...
[PORTFOLIO] valeur=1000.00 EUR cash=1000.00 EUR positions=0
[PORTFOLIO] NO_ACTION AMD CORE score=63.0029 montant=- EUR
[PORTFOLIO] NO_ACTION GLOBAL - score=n/a montant=- EUR
[TRADES] 0 transaction — DRY_RUN, aucune écriture
[PERFORMANCE] valeur=1000.00 EUR cumul=0.00 % ; MSCI World (proxy IWDA.AS)=0.00 %
```
## Organisation
```text
config/universe.json                  Actions, marchés, devises, benchmark
config/strategy.json                  Profil, poids, normalisation, seuils, limites
src/
  app.js                             Routes Express et erreurs
  server.js                          Démarrage et arrêt du serveur
  config/env.js                      dotenv et limites fixes
  db/supabase.js                     Client Supabase côté serveur
  db/investmentRepository.js          Persistance invest_* et RPC serveur
  data/marketDataProvider.js          Interface remplaçable de données
  data/providers/yahoo.js             Adaptateur Yahoo OHLC/volume/FX
  jobs/dailyAnalysis.js               Pipeline quotidien injectable
  jobs/daily-job.js                   Entrée Express conservée
  shared/not-implemented.js           Erreur explicite des modules futurs
  modules/
    market-data/index.js             Cours, FX et benchmark
    indicators/index.js              Indicateurs journaliers et historique
    scoring/index.js                 Score 0–100 et contributions
    portfolio/index.js               Valorisation et exécution virtuelle
    recommendations/index.js         BUY, HOLD, SELL, NO_ACTION
    performance/index.js             Performance et comparaison benchmark
    email/index.js                   Rendu HTML/texte et transport distincts
    email/summary.js                 Scores d'affichage et synthèse BUY/SELL/HOLD/WATCH
    email/report.js                  Rapport après finalisation et livraison via outbox
    email/transport.js               Gmail SMTP, parsing, validation et protection des secrets
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_aggressive_profile.sql
supabase/migrations/003_daily_analysis.sql
supabase/inspect_existing_tables.sql  Inventaire en lecture seule avant création
tests/aggressive-strategy.test.js
tests/supabase-isolation.test.js
tests/daily-analysis.test.js
tests/paper-trading-sql.test.js
tests/daily-report.test.js
tests/email-outbox.test.js
scripts/daily.js
scripts/email-test.js
scripts/check-syntax.js
Dockerfile
.env.example
package.json / package-lock.json
```
Les fournisseurs dépendent des contrats des modules ; les calculs ne dépendent ni d'Express ni de Supabase. Le repository borne les noms de tables via `TABLES`. L'orchestrateur est injectable pour tester le dry-run et les erreurs sans dépendance réseau.
## Supabase
### Configuration du projet existant
```dotenv
SUPABASE_URL=https://kqgfeusiwvycpuvecgab.supabase.co
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
PAPER_TRADING=true
```
Renseigner les valeurs de clés dans `.env` local, ignoré par Git, ou via Secret Manager pour Cloud Run. `.env.example` contient uniquement des emplacements vides pour les clés. L'ancienne variable `SUPABASE_SERVICE_ROLE_KEY` n'est plus utilisée. Le backend attend une nouvelle clé `sb_secret_...` dans `SUPABASE_SECRET_KEY` pour ses traitements privilégiés. La clé publishable est prévue pour un éventuel usage public, sans client public ni accès public aux tables InvestmentAdvisor dans cette version ; elle n'est pas nécessaire aux traitements serveur et n'est jamais utilisée à la place du secret.
`getSupabase()` reste différé, vérifie que l'URL correspond au projet indiqué et n'expose pas ses credentials dans les réponses HTTP. `InvestmentRepository` utilise la liste fermée `TABLES` dans `src/db/supabase.js` pour cibler uniquement les noms `invest_*`. Les calculs restent des fonctions pures et le secret n'est pas inclus dans la configuration exportée, les rapports ou les logs.
### Inspection et SQL à exécuter
1. Ouvrir le SQL Editor du **projet existant** et exécuter `supabase/inspect_existing_tables.sql`. Cette requête en lecture seule liste les relations du schéma public, colonnes, contraintes, marqueurs de propriété, RLS et index préfixés ; elle ne lit pas les données métier.
2. Vérifier l'absence de collision sur les noms de tables et d'index prévus.
3. Pour une nouvelle installation de l'application, appliquer 001, 002 puis 003, une seule fois chacune. Dans le projet actuel, l'utilisateur a déjà installé 001/002 : **exécuter seulement 003** pour cette étape. Une table présente n'est jamais réinitialisée.
La liste des autres tables communiquée est `chess_course_progress`, `chess_moves`, `chess_position_evaluations`, `chess_positions`, `chess_repertoires`, `chess_training_stats`, `games`. Elles sont conservées sans modification. La connexion au portefeuille Supabase et le job complet en dry-run ont été vérifiés en lecture seule. Aucune migration ni écriture n'a été exécutée contre le projet distant pendant cette étape.
La nouvelle 001 vérifie le catalogue PostgreSQL **avant la première création**, dans une transaction avec verrou de migration. Elle refuse tout objet portant un nom cible, un index explicite cible ou un nom ancien candidat, même si ce dernier pourrait appartenir à une autre application. Cette prudence impose une revue ; elle ne présume pas la propriété des noms génériques. Il n'y a pas de `CREATE TABLE IF NOT EXISTS` qui masquerait une table incompatible.
002 vérifie le marqueur `InvestmentAdvisor:invest:v1` et ajoute les colonnes agressives. 003 vérifie ce même marqueur avant de modifier uniquement les tables invest_*. Elle ajoute OHLC, indicateurs, alias `asset_id/date` avec contrainte unique, état de clôture des positions et lease. Elle remplace seulement la contrainte NO_ACTION par actif, son index global et la clé étrangère de recommandation du journal : un ordre exécuté aujourd'hui peut ainsi référencer une recommandation d'hier. Les références historiques sont conservées. Les fonctions RPC sont `SECURITY INVOKER` et exécutables uniquement par `service_role`, jamais par anon/authenticated. Il n'y a aucun effacement de lignes, suppression de table, changement global de RLS ni policy sur les autres applications.
Aucune migration de données ni aucun renommage n'est nécessaire pour cette première installation. Les contrôles de collision restent présents pour protéger les tables des autres applications et empêcher une réinitialisation accidentelle lors d'une seconde exécution.
| Ancien nom local | Nouveau nom | Usage |
| --- | --- | --- |
| `instruments` | `invest_assets` | Univers d'actions |
| `daily_prices` | `invest_market_prices` | Clôtures brutes et ajustées |
| `fx_rates` | `invest_fx_rates` | Conversion des devises vers EUR |
| `benchmarks` | `invest_benchmarks` | Définition des benchmarks |
| `benchmark_prices` | `invest_benchmark_prices` | Historique du benchmark |
| `portfolios` | `invest_portfolio` | Cash et coût engagé |
| `daily_runs` | `invest_daily_runs` | Runs quotidiens et reprises |
| `indicator_snapshots` | `invest_daily_metrics` | Indicateurs et facteurs agressifs |
| `investment_scores` | `invest_daily_scores` | Scores et contributions |
| `positions` | `invest_positions` | Positions ouvertes |
| `recommendations` | `invest_recommendations` | BUY/HOLD/SELL/NO_ACTION, risques et raisons |
| `paper_transactions` | `invest_transactions` | Transactions virtuelles |
| `portfolio_snapshots` | `invest_portfolio_daily` | Valorisation et performance quotidiennes |
| `daily_email_reports` | `invest_daily_email_reports` | Rapports HTML et état d'envoi |
| Aucun | `invest_news` | Catalyseurs sourcés par actif, avec déduplication fournisseur |
Les colonnes existantes comme `instrument_id` et `portfolio_id` sont conservées pour éviter un refactoring des contrats métier ; seules les tables et leurs références changent. `invest_news` complète le stockage JSON des facteurs et ne contient aucune donnée simulée au départ.
Les montants sont stockés en `numeric`. Les calculs monétaires futurs devront utiliser une arithmétique décimale avec une règle d'arrondi explicite ; éviter les flottants JavaScript pour les contrôles de limites. Les rendements sont des fractions (`0.05` = 5 %), les scores et le RSI sont entre 0 et 100.
RLS est activée exclusivement sur les nouvelles tables `invest_*`, sans policy publique et sans privilège de table pour `PUBLIC`, `anon` ou `authenticated`. Les droits serveur sont accordés sur ces tables au rôle `service_role`. Les tables et policies des autres applications ne sont pas modifiées. La clé secrète utilise ce rôle privilégié et contourne RLS : la conserver exclusivement côté serveur, hors HTML, email, frontend et logs. Ce secret n'est pas limité au préfixe `invest_` par Supabase ; la liste de tables borne les accès applicatifs, pas les privilèges intrinsèques de la clé. [Documentation Supabase sur les clés](https://supabase.com/docs/guides/getting-started/api-keys).
Les contraintes et RPC de 003 imposent le mode paper, le cash non négatif, les plafonds de coût/exposition, quatre positions, 35 %, le minimum de montant, le cooldown et deux emplacements par portefeuille/date. Chaque transaction verrouille le portefeuille et écrit cash, positions, journal et statut de recommandation atomiquement. La finalisation du run vérifie aussi les coûts et la valorisation du snapshot.
## Règles de portefeuille AGGRESSIVE
- Capital initial fixe : 1 000 EUR, sans apport supplémentaire, emprunt, levier ou vente à découvert.
- Hypothèse du squelette : « valeur investie » désigne le **coût EUR des positions ouvertes**, limité à 1 000 EUR. Ce coût doit correspondre à la somme des coûts des positions et être vérifié dans la transaction SQL.
- La valeur de marché peut dépasser 1 000 EUR après une hausse des cours. Si le plafond demandé porte sur la valeur de marché, prévoir des ventes de réduction à chaque valorisation ; un contrôle quotidien ne peut pas garantir ce plafond à tout instant. Au moment des achats, contrôler aussi que l'exposition de marché résultante ne dépasse pas 1 000 EUR.
- Quatre positions maximum ; poids maximal de 35 % de la valeur totale, cash inclus, après achat et frais. Les contrôles de proposition rejettent un dépassement. Les dérives dues au marché sont à signaler à la valorisation future ; elles ne produisent pas une vente automatique dans cette version.
- Jusqu'à 100 % du capital engagé, sans réserve de cash obligatoire, sans quota sectoriel ni nombre minimal de positions. Aucun achat n'est provoqué par la seule présence de cash.
- Deux transactions virtuelles au maximum par **date locale Europe/Paris**, BUY et SELL réunis ; les propositions réservent aussi les emplacements disponibles. Les recommandations HOLD/NO_ACTION ne consomment pas de transaction.
- Minimum d'achat et de vente partielle : 100 EUR hors frais. Exception : clôture totale d'un reliquat inférieur à 100 EUR. Les contrôles monétaires de proposition utilisent des centimes avec arrondis conservateurs ; les frais doivent être fournis explicitement, même à zéro.
- Quantités fractionnaires (huit décimales), frais configurables, pas de slippage ni règlement différé : conventions explicites de simulation. Les RPC utilisent `numeric` pour cash et journal. Un split affectant une position bloque le job pour réconciliation, plutôt que produire une valorisation artificielle. Les dividendes ne sont pas encore crédités au cash virtuel : la performance des positions représente ici cours bruts et frais, tandis que les indicateurs utilisent les clôtures ajustées. Cette limite est enregistrée dans `valuation_context.dividendsCredited=false`.
- HOLD signifie conserver une position existante. NO_ACTION signifie qu'aucune opération n'est justifiée ou exécutable ; conserver les raisons, par exemple données insuffisantes, marché fermé ou seuil non atteint.
Unicité des runs et slots, verrou de portefeuille, lease de 20 minutes renouvelée pendant l'ingestion et identifiant unique de recommandation protègent les retries Scheduler. Une clôture de position conserve sa ligne avec `closed_at` ; elle ne supprime rien. Les ordres d'un run incomplet ne sont jamais exécutés. Les dates viennent de l'horloge locale Europe/Paris et les RPC refusent une date de traitement différente. Aucun paramètre HTTP ne permet de changer la date ou le mode de trading.
## Données et indicateurs
`config/universe.json` contient 30 valeurs : 20 US et 10 européennes, avec symboles Yahoo séparés des identités symbole/MIC. La liste n'est pas dans le scoring et ne constitue pas une recommandation d'achat. Les positions détenues hors watchlist restent suivies sans autoriser de nouvel achat sur ces actifs.
Yahoo Finance via `yahoo-finance2` fournit OHLC, volume, clôtures ajustées, historique US/EU et taux FX sans clé API. C'est un accès non officiel, sans garantie de stabilité ou de disponibilité ; les retries et erreurs sont explicites et l'adaptateur est remplaçable. [Documentation du fournisseur logiciel](https://github.com/gadicc/yahoo-finance2). L'historique complet de 550 jours calendaires est rechargé pour les 30 actifs afin d'intégrer les révisions des ajustements ; les upserts ne créent pas de doublons. La console compte les lignes confirmées comme upsertées, sans prétendre distinguer insertions et mises à jour. Les jours fériés US/EU peuvent différer ; la date réelle du cours est conservée séparément du run.
Conventions proposées pour les futurs calculs, versionnées en base :
| Indicateur | Définition |
| --- | --- |
| Rendements 1/3/12 mois | Clôture ajustée courante / clôture ajustée au dernier jour de bourse à ou avant la date décalée de 1/3/12 mois calendaires − 1 |
| Rendement 5j / 6 mois | 5 variations de séance / même règle calendaire à 6 mois |
| SMA 20/50 | Moyenne des 20/50 dernières clôtures ajustées |
| MA200 | Moyenne des 200 dernières clôtures ajustées |
| RSI 14 | Lissage de Wilder sur 14 variations ; amorçage et cas sans gains/pertes à documenter |
| Volatilité 30 | Écart-type échantillonnal de 30 rendements logarithmiques, annualisé par √252 ; nécessite 31 clôtures |
| Volatilité 20/60 | Même calcul sur 20/60 variations ; nécessite 21/61 clôtures |
| Volume ratio | Volume de la dernière séance / moyenne des 20 séances précédentes, séance courante exclue |
| Distance 52w high | Clôture ajustée / plus haut OHLC ajusté des 252 séances précédentes − 1 ; séance courante exclue pour détecter une cassure |
| Drawdown 52w | Clôture ajustée / plus haut OHLC ajusté des 252 dernières séances, séance courante incluse − 1, borné à zéro |
Une donnée absente reste `null`, avec diagnostic. Le score nécessite MA200/historique de 200 séances et les facteurs techniques essentiels, pas tous les facteurs fondamentaux. Les rendements 12 mois et mesures 52 semaines peuvent rester absents sur une introduction récente. Les indicateurs utilisent la devise native ; la performance relative au marché convertit l'action et le benchmark en EUR sur les mêmes bornes calendaires, avec dates réelles conservées. Les performances de portefeuille utilisent cours bruts, quantités et FX EUR.
## Scoring et recommandations
La source unique des poids, bornes, seuils et limites est `config/strategy.json`. Le profil AGGRESSIVE utilise : momentum 1 mois 20 %, 3 mois 20 %, accélération 10 %, volume inhabituel 10 %, cassure/proximité du plus haut 10 %, relatif marché 10 %, relatif secteur 5 %, croissance/résultats 5 %, catalyseurs 10 %. SMA, RSI et rendement 12 mois restent dans le schéma et ne contribuent pas au score agressif.
Chaque facteur est normalisé linéairement entre les deux bornes configurées, puis borné à [0,100]. Les facteurs absents contribuent zéro **sans redistribution**, sont marqués manquants et réduisent la couverture. Secteur (5 %), résultats (5 %) et news (10 %) ne sont pas alimentés dans cette étape : le score maximum actuellement atteignable est donc **80/100**, avec confiance maximale **80 %**. Le seuil BUY reste 75 pour réserver les achats aux signaux quantitatifs très forts. Les moteurs acceptent déjà ces facteurs lorsqu'un adaptateur futur les fournira. Aucune news ni fondamentale n'est inventée, aucun appel OpenAI n'est effectué. Un facteur technique essentiel absent, un historique incomplet ou des données anciennes rendent le score `null`. Volatilité, valorisation et absence de dividende n'enlèvent pas directement de points.
| Facteur | Entrée et règle exacte |
| --- | --- |
| Momentum | `return1m`, `return3m`, fractions, bornes −10/+20 % et −20/+40 % |
| Accélération | `return5d − previousReturn5d` sur deux fenêtres consécutives non chevauchantes ; bornes −5/+10 points |
| Volume inhabituel | `volumeRatio20` = volume récent / moyenne des 20 séances précédentes ; bornes 0,8–2,5 ; composante zéro si rendement 5j négatif ou nul |
| Cassure | `distanceToHigh60` = clôture ajustée / plus haut ajusté des 60 séances précédentes (séance courante exclue) − 1 ; bornes −15/+2 % |
| Relatif marché/secteur | Rendement 1 mois action moins rendement 1 mois du marché/secteur, même période/devise ; bornes −10/+15 points |
| Croissance/résultats | Surprise relative des derniers résultats (`earnings.surprisePct`, fraction), bornes −10/+20 %, date et source requises |
| Catalyseurs | Preuve valide de plus grande force absolue, signée entre −1 et +1 ; à égalité, preuve défavorable retenue ; pas de cumul de news dupliquées |
Les preuves exigent `type`, `date`, `source`, `description`, `strength`, sans date future et datant de 30 jours au plus. Types acceptés : résultats supérieurs/inférieurs, guidance relevée/réduite, lancement produit, évolution réglementaire favorable/défavorable, révision analyste positive/négative et retournement identifié. La force signée doit venir d'un adaptateur de données avec une grille documentée ; le moteur ne fabrique aucune news, aucune surprise de résultats et ne fait pas d'analyse libre de texte. Le fournisseur et cette grille restent à choisir. Le proxy « croissance/résultats » repose ici sur la surprise publiée, faute de données fondamentales existantes.
BUY nécessite un score ≥75, une confiance ≥80 %, les deux composantes momentum ≥60 et au moins une confirmation accélération/volume/cassure/catalyseur ≥65. SELL nécessite une position détenue, un score ≤40 et la même confiance minimale. Entre les deux, HOLD pour une position existante ; NO_ACTION global si aucune transaction n'est justifiée/exécutable. La confiance exprime la couverture des données pondérée, **pas une probabilité de gain**. Les données du score doivent correspondre à la date d'analyse.
Classification : SPECULATIVE si volatilité annualisée ≥55 %, volatilité invalide/inconnue, risque de liquidité ou événementiel identifié ; sinon CORE sur critères quantitatifs. Liquidité : moyenne de turnover EUR sur 20 séances comparée à 1 million EUR, seuil dans `strategy.json`. Les risques non évalués et l'absence de news restent affichés, sans prétendre être absents ni classer automatiquement tous les titres SPECULATIVE. CORE conserve un risque élevé dans ce profil. La volatilité élevée peut donc accompagner un score fort et un BUY SPECULATIVE. Horizon : 1 à 3 mois, réanalyse quotidienne.
Cooldown de 7 jours calendaires après toute transaction exécutée sur l'instrument. Une nouvelle opération est permise pendant ce délai uniquement si le score évolue d'au moins 15 points dans le sens de l'ordre, ou si une preuve sourcée postérieure à la dernière transaction a une force ≥0,7 dans ce sens. Une simple atteinte du seuil −18/+25 % ne contourne pas le cooldown. Joindre le score de la recommandation exécutée à l'historique des transactions pour `scoreAtTrade` ; un score historique absent ne permet pas l'exception par variation de score.
Les seuils `STOP_REVIEW_PCT=-18` et `TAKE_PROFIT_REVIEW_PCT=25` portent sur le gain/perte latent par rapport au coût EUR de la position. `reviewPosition` marque une réanalyse ; ils ne provoquent **aucune vente automatique**. La réanalyse utilise le score courant et peut conclure HOLD, BUY ou SELL selon les autres règles.
Le moteur contrôle les limites avant toute proposition, réserve le cash et les emplacements des achats, et ne finance pas un achat par une vente seulement proposée. Il n'impose aucune diversification. Les candidats sans transaction sont conservés dans `decision_context.rejectedCandidates`, même si d'autres achats sont retenus.
### Configuration et contrats des fonctions
Configuration de stratégie : `RISK_PROFILE=AGGRESSIVE`, `STOP_REVIEW_PCT=-18`, `TAKE_PROFIT_REVIEW_PCT=25`, `COOLDOWN_DAYS=7`. Le profil inconnu, les seuils incohérents et tout mode réel font échouer le démarrage. En mode paper avec écriture, les paramètres du portefeuille sont synchronisés sous lease ; chaque décision conserve sa configuration effective. En dry-run, aucun paramètre SQL n'est modifié.
- `calculateInvestmentScore(indicators, parameters?)` consomme les champs du tableau, `asOfDate`, `historyComplete`, `dataFresh`, `volatility30`, `liquidityRisk`, `eventRisk`, `earnings` et `catalysts`. `dataFresh` doit couvrir aussi les séries de comparaison. Les contrôles de qualité et l'alimentation des nouveaux facteurs restent la responsabilité de l'ingestion et des indicateurs futurs. `invest_daily_metrics.signal_features` conserve ces entrées ; `invest_daily_scores.signal_context` conserve leurs diagnostics.
- `generateRecommendations({ asOfDate, portfolio, candidates, tradeHistory }, parameters?)` exige un portefeuille valorisé (`cashEur`, `investedCostEur`, `totalValueEur`, `positions`) et l'historique complet nécessaire au cooldown/jour courant (`instrumentId`, `tradeDate`, `side`, `scoreAtTrade`), trié par heure d'exécution croissante pour départager deux transactions à la même date. Chaque candidat contient `instrumentId`, `symbol`, `indicators`, `priceEur`, `feesEur`, `executionReady`. Les positions contiennent `instrumentId`, `quantity`, `costBasisEur`, `marketValueEur`. L'adaptateur d'exécution doit affirmer `executionReady=true` seulement après contrôle cours/FX/calendrier/convention de simulation. Les identifiants persistés doivent être les UUID Supabase.
- `toRecommendationRow(record, runId)` mappe les résultats vers les colonnes de `invest_recommendations` ; elle n'effectue aucune écriture.
- `renderDailyEmail(report)` produit HTML échappé et texte : `date`, `totalValueEur`, `cashEur`, `cumulativeReturn`, `benchmark`, `positions`, `recommendations`, `executedTransactions`. Le transport reste désactivé.
Le modèle d'exécution est `next-session-open`. Les ordres antérieurs sont sélectionnés par actif, puis ventes d'abord et scores décroissants, avec départage par symbole. Les recommandations sont recalculées après les exécutions ; les décisions remplacées restent tracées comme rejetées. Le snapshot est finalisé atomiquement avec l'état completed du run.
## Performance et email
Sans apports/retraits : performance cumulée = `valeur totale EUR / 1000 − 1` ; performance quotidienne = `valeur du jour / valeur du snapshot précédent − 1`. Le premier jour utilise les 1 000 EUR initiaux. Valoriser après les transactions, frais inclus.
Benchmark : ETF **IWDA.AS**, proxy MSCI World coté à Amsterdam en EUR. Ce n'est pas une cotation directe de l'indice ; sa performance comprend les caractéristiques propres de l'ETF. [Fiche de l'émetteur](https://www.blackrock.com/dk/individual/products/251882/ishares-core-msci-world-ucits-etf). La première finalisation initialise une base commune, puis rendement = `niveau courant / niveau initial − 1`. Un changement de proxy après initialisation est refusé pour préserver la comparaison historique. L'écart est exprimé en points de pourcentage.
Le rendu email commence par **ACTION DU JOUR** : les propositions d'achat/vente ou **AUCUNE OPÉRATION AUJOURD’HUI**. Puis viennent valeur, cash, performance cumulée, benchmark daté MSCI World, positions existantes, BUY, SELL, HOLD, TOP 5 WATCH, raisons/risques et exécutions déjà réalisées. Le HTML est échappé et le sujet ne contient pas de saut de ligne.

### Synthèse et score technique d'affichage

`summary` contient `actionRequired`, `headline`, `buys`, `sells`, `holds`, `watch`, `noActionCount` et `explanation`. Le compte NO_ACTION exclut la recommandation globale. Les listes présentent les informations utiles sans recopier toute la configuration ou les composants internes. WATCH est limité aux **cinq meilleurs NO_ACTION ayant un score réel numérique sous le seuil BUY** (tri décroissant, puis symbole). Il ne constitue jamais une action métier et n'est pas persisté dans `invest_recommendations`.

Chaque recommandation est enrichie en mémoire avec `finalScore` (score métier inchangé), `technicalScore`, `dataCoveragePct`, `missingFactors`, `buyThreshold` et `gapToBuy`. Le score technique est la moyenne des scores de composants effectivement disponibles, pondérée par leurs poids et renormalisée sur 100. La couverture mesure le poids disponible sur le poids total. Si aucun composant exploitable n'existe, le score technique est `null`. Exemple : AMD réel 63.0, technique 78.8, couverture 80 %. Même avec ce score technique supérieur à 75, la décision reste NO_ACTION si les règles métier ne valident pas BUY.

### Email après finalisation et outbox

```dotenv
EMAIL_ENABLED=false
EMAIL_PROVIDER=gmail-smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=christophe.decugis@gmail.com
SMTP_PASSWORD=
EMAIL_FROM="Coach Invest <christophe.decugis@gmail.com>"
EMAIL_TO=
```

`EMAIL_ENABLED=false` génère uniquement le rendu et conserve `emailSent=false`, sans créer de connexion SMTP. Le fournisseur supporté est **gmail-smtp**. Le mot de passe d'application Gmail doit être renseigné uniquement dans **SMTP_PASSWORD** : `.env` local ignoré par Git, ou Secret Manager pour Cloud Run. Il est lu au moment de créer le transport et ne figure ni dans la configuration publique du moteur, ni dans l'API, ni dans l'outbox. Nodemailer ne logue pas le dialogue SMTP ; les erreurs propagées masquent le mot de passe et ses encodages AUTH.

La validation est effectuée avant l'envoi et avant réservation de l'outbox : présence de SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, EMAIL_TO et EMAIL_PROVIDER ; port valide ; booléen SMTP_SECURE valide. Un fournisseur inconnu retourne `EMAIL_PROVIDER_UNSUPPORTED` et une variable manquante une erreur explicite nommant uniquement la variable. Le run d'analyse reste finalisé.

Pour **587**, `secure=false` et STARTTLS est exigé par `requireTLS=true` ; la vérification normale du certificat est conservée. Il n'y a ni pool ni retry de livraison. [Configuration SMTP officielle Nodemailer](https://nodemailer.com/smtp), [paramètres Gmail](https://support.google.com/mail/answer/7104828), [mot de passe d'application Google](https://support.google.com/mail/answer/185833).

EMAIL_TO accepte des adresses simples séparées par **virgule ou point-virgule**. Les valeurs sont trimées, les entrées vides supprimées et les doublons éliminés sans distinction de casse. Exemple : `EMAIL_TO="premier@example.com; second@example.com, premier@example.com"` enverra à deux destinataires. EMAIL_FROM accepte `Coach Invest <christophe.decugis@gmail.com>`. Un refus SMTP partiel est traité comme un échec sans nouvel envoi automatique, car certains destinataires peuvent déjà avoir reçu le message.

### Backfill historique de 30 jours

```powershell
npm run backfill:30d
```

La commande charge `config/universe.json` (ou `UNIVERSE_CONFIG_PATH`) et les actifs activés, avec leurs `providerSymbol` Yahoo. Elle couvre les **30 jours calendaires terminés, de J−30 à J−1**, dans `APP_TIMEZONE` ; aucune bougie n'est inventée pour les week-ends, jours fériés ou dates manquantes. Pour écrire dans Supabase, renseigner `SUPABASE_URL`, `SUPABASE_SECRET_KEY` et **`DRY_RUN=false`** dans le `.env`. Avec `DRY_RUN=true`, les téléchargements et calculs ont lieu mais aucune donnée n'est écrite.

Un historique antérieur de `HISTORY_LOOKBACK_DAYS` (550 jours par défaut) est téléchargé en mémoire pour MA200, les rendements longs et les comparaisons marché. Seule la fenêtre de 30 jours est persistée dans `invest_market_prices`, `invest_daily_metrics`, `invest_benchmark_prices` et `invest_fx_rates`. Les références manquantes sont ajoutées à `invest_assets` et le benchmark est synchronisé dans `invest_benchmarks`, sans modifier l'affectation du portefeuille. Le benchmark par défaut est IWDA.AS, et les conventions FX restent celles de l'adaptateur quotidien (EUR par unité, inversion USD, GBX/GBP).

Chaque métrique à la date D utilise uniquement les observations datées au plus tard D, y compris FX et benchmark ; un taux absent ou trop ancien reste indisponible. Les indicateurs sans historique suffisant sont `null`. Les prix ajustés sont rebasés à la clôture D pour éliminer le facteur multiplicatif d'ajustements de splits/dividendes postérieurs : `calculation_version=historical-indicators-v1-asof-rebased`. Yahoo fournit un historique corrigé actuel, pas une archive des valeurs publiées à l'époque ; ce backfill ne constitue donc pas un backtest avec des données archivées à chaque date.

Les UPSERTs utilisent les clés existantes, dont `(asset_id,date)` pour les cours et `(instrument_id,as_of_date)` pour les métriques : une relance actualise les données corrigées sans doublons. Les logs par symbole indiquent les lignes de la fenêtre récupérées/upsertées, les dates extrêmes et les erreurs. Une erreur laisse les autres symboles continuer ; la commande quitte avec un code non nul si le backfill est partiel, sans annuler les données réussies.

Aucun score, recommandation, transaction, portefeuille, performance quotidienne, run ou email n'est rétro-populé ou exécuté. L'outbox n'est pas touchée. Aucune nouvelle migration n'est nécessaire après les migrations existantes 001–003.

### Test du rapport complet depuis la base

Avec les variables Supabase et SMTP du `.env` existant, et `EMAIL_ENABLED=true`, lancer :

```powershell
npm run email:test-report
```

Le script sélectionne le dernier `invest_daily_runs` au statut `completed` pour le portefeuille InvestmentAdvisor, puis réutilise `getCompletedReport`, `buildDailyReport` et `renderDailyEmail`. Snapshot, recommandations et transactions déjà enregistrées sont relus sans lancer de job, de scoring ou d'ordre. Le sujet est `InvestCoach — test rapport complet — <date>` et les logs indiquent `manual test report`. En l'absence de run finalisé, l'erreur est `NO_FINALIZED_REPORT_AVAILABLE`.

Ce test envoie directement via le transport SMTP de production sans lire ni écrire l'outbox normale. Chaque invocation manuelle peut donc envoyer à nouveau le même rapport ; aucun retry automatique n'est effectué. Avec `EMAIL_ENABLED=false`, aucun email n'est envoyé.

### Test SMTP local indépendant

Renseigner le `.env` existant sans l'écraser, ajouter le mot de passe d'application dans SMTP_PASSWORD et les destinataires dans EMAIL_TO. Définir explicitement `EMAIL_ENABLED=true` pour autoriser ce test, puis :

```powershell
npm run email:test
```

Le script utilise le même transport Gmail et les mêmes variables que la production. Il n'importe ni le moteur d'investissement ni Supabase, et n'écrit aucune outbox. Il envoie un email par exécution manuelle, sujet `InvestCoach — test email`, texte `Test d'envoi SMTP InvestmentAdvisor réussi.` et HTML équivalent. Le succès affiche uniquement `Email sent successfully` (en dehors de l'en-tête standard npm). L'échec affiche name/message/code et éventuellement responseCode SMTP, sans credential, puis quitte avec un code non nul. Avec EMAIL_ENABLED=false, il n'envoie rien et affiche `EMAIL_DISABLED`.

Les tests automatisés `npm test` mockent Nodemailer : aucun accès Gmail. Après votre test manuel, remettre EMAIL_ENABLED=false si vous souhaitez conserver uniquement le rendu.

Après le retour réussi du moteur et la finalisation du run, l'orchestrateur génère le rapport. Si un destinataire est renseigné en mode paper avec écritures, il ajoute le rendu à **`invest_daily_email_reports` existante**. Aucun nouveau SQL/migration n'est nécessaire. Sans destinataire et avec email désactivé, seul le rendu en mémoire est produit. En dry-run, aucune outbox ni livraison, même si EMAIL_ENABLED est activé.

L'outbox conserve la première liste de destinataires nettoyée et le premier rendu avec `UNIQUE(run_id)`. Les runs sont déjà uniques par portefeuille/date. Un update conditionnel atomique réserve uniquement `pending` avec `attempt_count=0` et le passe à `sending` avec une seule tentative. Seul le gagnant envoie. Les états `sending`, `failed` et `sent` ne sont jamais repris automatiquement. Un crash après réservation ou un timeout ambigu peut donc laisser un email non livré ; cette convention privilégie l'absence de doublons. SMTP ne fournit pas de clé d'idempotence serveur : la réservation de l'outbox et l'absence de retry assurent une seule tentative côté application. Ne pas réinitialiser une outbox ambiguë pour provoquer un second envoi.

Une panne de rendu, d'outbox ou d'envoi retourne le rapport d'analyse avec une erreur email et préserve `status: completed`. Elle n'appelle jamais la finalisation en échec du run et ne rejoue aucun ordre. Si l'envoi a réussi mais que la confirmation DB a échoué, `emailSent: true` et `emailStatus: sent_unconfirmed` sont retournés ; l'outbox reste réservée. `emailSent: false` indique l'absence de confirmation d'envoi, pas une garantie de non-réception après un timeout fournisseur.

Un nouvel appel pour un run déjà terminé lit son snapshot, ses décisions et ses transactions enregistrés : il restitue le rapport complet sans recalculer ni rejouer les transactions. La CLI `npm run daily` utilise le même orchestrateur et affiche le texte de l'email à la suite des logs techniques.
## Cloud Run et Cloud Scheduler
Le Dockerfile utilise Node.js 24 et `npm ci`, avec un utilisateur non root et le port fourni par Cloud Run. Les secrets doivent venir de Secret Manager, pas d'une image ni du dépôt.
Déploiement prévu après configuration du projet GCP :
```text
gcloud run deploy investment-advisor --source . --project investcoach --region europe-west1 --no-allow-unauthenticated --timeout 900
```
Conserver Cloud Run **privé**. Autoriser le compte de service Scheduler et les comptes autorisés à déclencher manuellement l'analyse avec `roles/run.invoker`. Configurer le job Scheduler HTTP avec un jeton OIDC. Audience : URL de base du service Cloud Run ; cible : `POST https://SERVICE_URL/jobs/daily`. Le contrôle IAM est effectué par Cloud Run. [Guide officiel Cloud Run/Scheduler](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).
### Gmail SMTP sur Cloud Run et Secret Manager

Le fichier `.env` local n'est pas inclus dans l'image. Configurer les variables email sur la révision Cloud Run et injecter **SMTP_PASSWORD** depuis Secret Manager :

1. Dans le projet **investcoach**, créer le secret `investcoach-smtp-password` via la console Secret Manager, ou ajouter une version s'il existe déjà. Saisir le mot de passe d'application Gmail directement dans la console, sans le mettre dans une commande, un fichier du dépôt ou l'historique du terminal.
2. Accorder au **compte de service d'exécution Cloud Run** `roles/secretmanager.secretAccessor` sur ce secret. Il s'agit du compte d'exécution, pas du compte Scheduler.
3. Déployer avec les paramètres non secrets et le binding de la version du secret. Remplacer les destinataires de l'exemple ; le point-virgule évite de perturber le séparateur virgule de gcloud.

```powershell
$gmailEnv = @(
  'EMAIL_ENABLED=false',
  'EMAIL_PROVIDER=gmail-smtp',
  'SMTP_HOST=smtp.gmail.com',
  'SMTP_PORT=587',
  'SMTP_SECURE=false',
  'SMTP_USER=christophe.decugis@gmail.com',
  'EMAIL_FROM=Coach Invest <christophe.decugis@gmail.com>',
  'EMAIL_TO=premier@example.com;second@example.com'
) -join ','

gcloud run deploy investment-advisor --source . --project investcoach --region europe-west1 --no-allow-unauthenticated --timeout 900 --update-env-vars $gmailEnv --update-secrets 'SMTP_PASSWORD=investcoach-smtp-password:1'
```

Remplacer `:1` par la version effectivement créée. `--update-env-vars` et `--update-secrets` conservent les autres paramètres et bindings existants, notamment Supabase. [Guide officiel Cloud Run / Secret Manager](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

Après le test SMTP local réussi et la configuration cloud, activer explicitement l'envoi :

```powershell
gcloud run services update investment-advisor --project investcoach --region europe-west1 --update-env-vars "EMAIL_ENABLED=true"
```

Pour envoyer les rapports quotidiens, le run doit être réellement finalisé : `DRY_RUN=false`, `PAPER_TRADING=true` et schéma quotidien installé. DRY_RUN=true continue à produire uniquement le rendu sans livraison, même si EMAIL_ENABLED=true. Le service reste privé sous IAM ; aucune ressource cloud n'est créée par le code ou les tests automatisés.

Sous PowerShell, entourer **toute la liste** de variables de guillemets, pour éviter qu'elle soit interprétée comme un tableau puis concaténée dans la valeur de DRY_RUN :

```powershell
gcloud run services update investment-advisor --project investcoach --region europe-west1 --update-env-vars "DRY_RUN=false,EMAIL_ENABLED=true,EMAIL_PROVIDER=gmail-smtp,PAPER_TRADING=true"
```

Les séries FX sont normalisées à une seule ligne par date/devise, en conservant la dernière cotation actualisée. Le repository déduplique également la clé `(rate_date,currency)` avant les upserts, afin d'éviter l'erreur PostgreSQL « ON CONFLICT DO UPDATE command cannot affect row a second time ». Aucune ligne existante n'est supprimée.

### Déclenchement manuel authentifié
La route existante est **POST `/jobs/daily`** ; aucune route `/run` supplémentaire n'est nécessaire. Après redéploiement, elle retourne le rapport complet : `status`, `startTime`, `endTime` (ISO 8601 UTC), `assetsProcessed`, `recommendations`, `transactions`, `errors`, ainsi que `dryRun`, `paperTrading`, `date`, `portfolio`, `performance`, `benchmark`, **`summary`**, **`emailRendered`**, **`emailSent`**, `emailStatus` et `email: { subject, html, text }`. `assetsProcessed` compte les actifs distincts évalués, y compris ceux ayant une erreur de données, sans compter la recommandation globale NO_ACTION. Les recommandations et transactions sont des tableaux ; les transactions du dry-run sont toujours vides.
Conserver `DRY_RUN=true` et `PAPER_TRADING=true` dans les variables **Cloud Run** pour ce test. Le `.env` local n'est pas déployé. Les paramètres du corps et de la query HTTP sont ignorés : ils ne peuvent changer ni le mode ni la date d'analyse.
Depuis PowerShell, avec votre compte Google connecté et autorisé à invoquer le service :
```powershell
gcloud auth login
$serviceUrl = (gcloud run services describe investment-advisor --project investcoach --region europe-west1 --format="value(status.url)").Trim()
$identityToken = (gcloud auth print-identity-token).Trim()
$report = Invoke-RestMethod -Method Post -Uri "$serviceUrl/jobs/daily" -Headers @{ Authorization = "Bearer $identityToken" } -ContentType "application/json" -Body '{}' -TimeoutSec 900
$report | ConvertTo-Json -Depth 20
```
Ne pas afficher ni enregistrer le jeton. Cette authentification suit le [guide officiel pour les développeurs](https://docs.cloud.google.com/run/docs/authenticating/developers). Adapter le nom du service ou la région si le déploiement réel diffère. Un refus IAM 401/403 vient de Cloud Run avant Express et ne possède donc pas nécessairement cette structure JSON.
Un succès retourne HTTP 200, même si certains actifs indisponibles ou une panne d'email sont explicitement listés dans `errors`. `already_completed` restitue le rapport enregistré, sans nouvelle analyse. Un échec du moteur retourne HTTP 500, `{"error":"INTERNAL_ERROR"}` sans détail sensible : les vrais détails sont filtrés puis logués côté serveur. Le moteur ne renvoie pas de bilan partiel ; en mode paper avec écritures, cela ne signifie pas qu'aucune transaction n'a été enregistrée avant l'échec. Le journal Supabase reste la référence.
Exemple de planning à adapter au délai de publication du fournisseur : `30 23 * * 1-5` avec fuseau `Europe/Paris`. Contrôler les calendriers boursiers dans le pipeline ; le cron ne connaît pas les jours fériés. Prévoir timeout HTTP, retries et durée maximale cohérents. Un futur pipeline trop long devra être exécuté dans un Cloud Run Job plutôt que survivre en arrière-plan après la réponse HTTP.
Le Scheduler peut utiliser `/jobs/daily` après installation de 003 et validation locale. Définir explicitement `DRY_RUN=false` pour enregistrer les analyses paper. La récupération séquentielle de 30 titres peut prendre plusieurs minutes : adapter les timeouts Cloud Run/Scheduler (par exemple 900 s) et conserver les retries. Aucun déploiement ni ressource cloud n'est créé par ces fichiers.
## Étapes suivantes
1. Installer 003, valider le dry-run puis un run paper dans le projet existant.
2. Ajouter secteur, résultats et news sourcés lorsque leurs fournisseurs sont choisis.
3. Réconcilier splits et dividendes virtuels ; enrichir le modèle de frais/slippage si nécessaire.
4. Tester Gmail SMTP puis activer EMAIL_ENABLED avec SMTP_PASSWORD dans Secret Manager.
5. Déployer Cloud Run privé et le Scheduler après validation des conventions.
`npm run check` vérifie la syntaxe JavaScript. `npm test` couvre le score, les preuves, les limites, les réservations, l'absence d'achats forcés, les réanalyses non automatiques, le cooldown, le rendu email, les noms SQL, les credentials serveur et le verrouillage du paper trading. Les migrations ont également été exécutées sur PostgreSQL local en mémoire pour vérifier les collisions, RLS, le refus d'accès anonyme et la préservation d'une table étrangère ; cela ne remplace pas l'inventaire du projet distant. Avant activation, vérifier aussi les devises, splits, arrondis d'exécution, retries et la concurrence dans la RPC.
