import { config } from './config/env.js';
import { app } from './app.js';

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`InvestmentAdvisor écoute sur le port ${config.port} (paper trading).`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
