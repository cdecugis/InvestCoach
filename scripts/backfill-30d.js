import { pathToFileURL } from 'node:url';
import { runBackfill30d } from '../src/data/backfill.js';
import { redactLogText } from '../src/shared/error-log.js';

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runBackfill30d();
    // Les écritures réussies restent acquises ; un code non nul signale le backfill partiel.
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(redactLogText(`[BACKFILL] Échec : ${error.message}`));
    process.exitCode = 1;
  }
}
