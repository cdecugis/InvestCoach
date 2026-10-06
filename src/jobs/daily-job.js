import { runDailyAnalysis } from './dailyAnalysis.js';

/**
 * Point d'entrée conservé pour Express ; pipeline implémenté dans dailyAnalysis.
 * 1. Acquérir en base le run unique portefeuille/date locale, avec lease.
 * 2. Charger l'univers, récupérer puis upsert cours, FX et benchmark.
 * 3. Calculer et enregistrer indicateurs et scores.
 * 4. Valoriser le portefeuille et produire les recommandations.
 * 5. Exécuter au plus deux transactions virtuelles via RPC atomique.
 * 6. Revaloriser, enregistrer snapshot/performance et finaliser le run.
 * Le transport email n'est pas encore branché sur ce pipeline.
 * Reprise par étapes : ne jamais rejouer une transaction déjà enregistrée.
 */
export async function runDailyJob(options = {}) {
  return runDailyAnalysis(options);
}
