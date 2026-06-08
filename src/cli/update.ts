import type { Command } from 'commander';
import { ensureGlobalConfig } from '../config.js';
import { resolveTargetProjects } from '../app/projects.js';
import { runUpdate, isUnhealthy } from '../app/update.js';
import type { RunProfile } from '../pipeline/run-project.js';

interface UpdateOpts {
  fast: boolean;
  full: boolean;
  global: boolean;
  dashboard: boolean;
  verify: boolean;
  invalidateCache: boolean;
  yes: boolean;
  json: boolean;
}

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Incrementally refresh one project (or all registered): sync, ingest, link, dashboard')
    .argument('[path]', 'Project root (default: every registered project)')
    .option('--fast', 'Transcript-only: skip code analysis + domain enrichment', false)
    .option('--full', 'Reprocess all windows (e.g. after a model change)', false)
    .option('--global', 'Rebuild the cross-project (global) dashboard too', false)
    .option('--no-dashboard', 'Skip dashboard rebuild')
    .option('--verify', 'Run the verifier pass after ingest', false)
    .option('--invalidate-cache', 'Clear cached agent runs first (after a model change)', false)
    .option('-y, --yes', 'Non-interactive', false)
    .option('--json', 'Machine-readable JSON output', false)
    .action(async (path: string | undefined, opts: UpdateOpts) => {
      ensureGlobalConfig();

      const projects = resolveTargetProjects(path);
      if (projects.length === 0) {
        console.error('No projects to update. Pass a path, or run `subnet setup` first.');
        process.exit(1);
      }

      const profile: RunProfile = opts.fast ? 'fast' : opts.full ? 'full' : 'default';
      const result = await runUpdate({
        projects,
        profile,
        global: opts.global,
        dashboard: opts.dashboard,
        verify: opts.verify,
        invalidateCache: opts.invalidateCache,
        onProgress: opts.json ? undefined : (ev) => logProgress(ev),
        onProjectDone: opts.json ? undefined : (r) => {
          const rate = r.runs > 0 ? Math.round((r.failures / r.runs) * 100) : 0;
          const failNote = r.failures > 0 ? ` · ${r.failures}/${r.runs} agent failures (${rate}%)` : '';
          console.log(`${r.name}: ${r.ok ? 'ok' : 'failed'}${r.error ? ` — ${r.error}` : ''} (${Math.round(r.durationMs / 1000)}s)${failNote}`);
        },
      });

      if (!result.locked) {
        console.error('Another `subnet update` is already running (lock held). Try again shortly.');
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ profile, projects: result.projects, globalDashboardPath: result.globalDashboardPath, warnings: result.globalWarnings }, null, 2));
      } else {
        for (const w of result.globalWarnings) console.warn(`warning: ${w}`);
        if (result.globalDashboardPath) console.log(`Global dashboard: ${result.globalDashboardPath}`);
      }

      if (result.projects.some(isUnhealthy)) process.exit(1);
    });
}

function logProgress(ev: { kind: string; project?: string; stage?: string; current?: number; total?: number }): void {
  if (ev.kind === 'stage') console.log(`  [${ev.project ?? 'global'}] ${ev.stage}`);
  else if (ev.kind === 'global') console.log(`  [global] ${ev.stage}`);
  else if (ev.kind === 'progress' && ev.total) console.log(`    ${ev.project} ${ev.stage}: ${ev.current}/${ev.total}`);
}
