import type { Command } from 'commander';
import { collectDoctorReport, runDoctorFixes, type DoctorReport, type ProjectHealth } from '../app/doctor.js';

interface DoctorOpts {
  fix: boolean;
  json: boolean;
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose config + project/global health; optionally repair common gaps')
    .argument('[path]', 'Project root (default: every registered project)')
    .option('--fix', 'Repair missing summaries, re-link, and rebuild dashboards', false)
    .option('--json', 'Machine-readable JSON output', false)
    .action(async (path: string | undefined, opts: DoctorOpts) => {
      const report = collectDoctorReport(path);

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report);
      }

      if (opts.fix) {
        await applyFixes(path);
      } else if (report.health.some((h) => h.conceptsMissingSummary > 0)) {
        console.log('\nRun `subnet doctor --fix` to repair missing summaries and re-link.');
      }
    });
}

export function printReport(report: DoctorReport): void {
  console.log('subnet doctor\n');
  if (report.findings.length === 0 && report.warnings.length === 0) console.log('  No config issues found.');
  for (const f of report.findings) console.log(`  \x1b[31merror\x1b[0m  ${f}`);
  for (const w of report.warnings) console.log(`  \x1b[33mwarn\x1b[0m   ${w}`);

  if (report.health.length > 0) {
    console.log('\nProjects:');
    for (const h of report.health) console.log(`  ${formatHealth(h)}`);
  }
}

function formatHealth(h: ProjectHealth): string {
  const failRate = h.recentRuns > 0 ? Math.round((h.recentFailures / h.recentRuns) * 100) : 0;
  return (
    `${h.name.padEnd(20)} unclustered=${h.unclusteredFacts} ` +
    `missingSummaries=${h.conceptsMissingSummary} pendingFiles=${h.pendingFiles} ` +
    `failures(24h)=${h.recentFailures}/${h.recentRuns} (${failRate}%)` +
    (h.modelDrift ? '  \x1b[33m[model config changed → run `subnet update --full`]\x1b[0m' : '')
  );
}

export async function applyFixes(path?: string): Promise<void> {
  console.log('\nApplying fixes...');
  const result = await runDoctorFixes(path);
  for (const p of result.perProject) {
    if (p.attempted > 0) console.log(`  ${p.path}: repaired ${p.summarized}/${p.attempted} summaries`);
  }
  for (const w of result.globalWarnings) console.warn(`  warning: ${w}`);
  if (result.globalDashboardPath) console.log(`  Global dashboard: ${result.globalDashboardPath}`);
  console.log('Done.');
}
