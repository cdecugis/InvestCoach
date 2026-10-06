import express from 'express';
import { runDailyJob } from './jobs/daily-job.js';
import { NotImplementedError } from './shared/not-implemented.js';
import { config } from './config/env.js';
import { errorLogEntry } from './shared/error-log.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/health', (req, res) => {
  res.json({ application: 'InvestmentAdvisor', status: 'ok', mode: 'paper', dryRun: config.dryRun, dailyJobImplemented: true });
});

// Cloud Run privé doit imposer IAM/OIDC avant l'arrivée de la requête.
// Aucun paramètre HTTP n'est transmis au job : seuls les réglages serveur font foi.
export function createDailyJobHandler(job = runDailyJob, now = () => new Date(), logError = console.error) {
  return async (req, res) => {
    const startTime = now().toISOString();
    try {
      const result = await job();
      const recommendations = result.recommendations ?? [];
      const errors = recommendations.filter(record => record.instrumentId && record.reasons?.some(reason =>
        reason.startsWith('Source indisponible :'))).map(record => ({
        code: 'MARKET_DATA_UNAVAILABLE', symbol: record.symbol,
        message: 'Données indisponibles pour cet actif ; aucune transaction proposée.'
      }));
      res.json({ ...result, status: result.status, startTime, endTime: now().toISOString(),
        dryRun: result.dryRun, paperTrading: true, date: result.date,
        assetsProcessed: new Set(recommendations.map(record => record.instrumentId).filter(Boolean)).size,
        recommendations, transactions: result.executedTransactions ?? [], errors: [...(result.errors ?? []), ...errors] });
    } catch (error) {
      // Les détails externes peuvent contenir des credentials : ne pas les retourner.
      logError(errorLogEntry('request_failed', error));
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  };
}
app.post('/jobs/daily', createDailyJobHandler());

app.use((error, req, res, next) => {
  if (error instanceof NotImplementedError) {
    return res.status(501).json({ error: error.code, message: error.message });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }
  console.error(errorLogEntry('request_failed', error));
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});
