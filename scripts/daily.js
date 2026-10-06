import { runDailyAnalysis } from '../src/jobs/dailyAnalysis.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--dry-run', '--execute-paper'].includes(arg)) || args.length > 1) {
  console.error('Usage : npm run daily [-- --dry-run | --execute-paper]');
  process.exit(1);
}
try {
  await runDailyAnalysis(args.includes('--dry-run') ? { dryRun: true }
    : args.includes('--execute-paper') ? { dryRun: false } : {});
} catch (error) {
  console.error(`[DAILY] Échec : ${error.message}`);
  process.exitCode = 1;
}
