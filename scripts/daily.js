import { runDailyJob } from '../src/jobs/daily-job.js';
import { redactLogText } from '../src/shared/error-log.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--dry-run', '--execute-paper'].includes(arg)) || args.length > 1) {
  console.error('Usage : npm run daily [-- --dry-run | --execute-paper]');
  process.exit(1);
}
try {
  const report = await runDailyJob(args.includes('--dry-run') ? { dryRun: true }
    : args.includes('--execute-paper') ? { dryRun: false } : {});
  console.log(redactLogText(report.email?.text ?? report.summary.headline));
} catch (error) {
  console.error(redactLogText(`[DAILY] Échec : ${error.message}`));
  process.exitCode = 1;
}
