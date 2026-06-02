import type { Command } from 'commander';
import { resolve } from 'path';
import { discoverWorkspaces } from '../setup/discover.js';
import { buildSetupPlan } from '../setup/plan.js';
import { runSetupPipeline } from '../setup/run.js';
import { formatDiscoverTable, formatPlanTable } from '../setup/format.js';
import type { AgentId } from '../types.js';
import { spawn } from 'child_process';

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parseProjectsArg(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => resolve(s.trim())).filter(Boolean);
}

function parseAgentsArg(raw?: string): AgentId | undefined {
  if (!raw) return undefined;
  const ids: AgentId[] = ['cursor', 'claude-code', 'codex', 'copilot'];
  if (!ids.includes(raw as AgentId)) throw new Error(`Unknown agent: ${raw}`);
  return raw as AgentId;
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('Interactive first-run: discover workspaces, estimate cost, run full pipeline')
    .option('--discover-only', 'List discoverable workspaces and exit')
    .option('--plan-only', 'Show pre-flight estimate for selected projects')
    .option('--projects <paths>', 'Comma-separated project roots (non-interactive)')
    .option('--agents <id>', 'Limit discovery to one agent adapter')
    .option('--skip-dashboard', 'Skip dashboard build at the end')
    .option('--prose', 'Generate portfolio prose via ProfileWriter', false)
    .option('--verify', 'Run verify after ingest per project', false)
    .option('--reprocess', 'Re-run triage/extract over all windows', false)
    .option('--yes', 'Skip confirmation prompts', false)
    .option('--json', 'Machine-readable JSON output', false)
    .option('--open', 'Open dashboard in browser when done', false)
    .action(async (opts: {
      discoverOnly: boolean;
      planOnly: boolean;
      projects?: string;
      agents?: string;
      skipDashboard: boolean;
      prose: boolean;
      verify: boolean;
      reprocess: boolean;
      yes: boolean;
      json: boolean;
      open: boolean;
    }) => {
      const p = await import('@clack/prompts');
      const agentFilter = parseAgentsArg(opts.agents);
      p.intro('subnet setup');

      const discovered = await discoverWorkspaces({ agentFilter });

      if (opts.discoverOnly) {
        if (opts.json) {
          console.log(JSON.stringify(discovered, null, 2));
        } else {
          console.log(formatDiscoverTable(discovered));
        }
        p.outro('Discovery complete');
        return;
      }

      let selected: string[] = parseProjectsArg(opts.projects);

      if (selected.length === 0) {
        if (!isTTY()) {
          console.error('No TTY and no --projects specified. Use --projects /path/a,/path/b');
          process.exit(1);
        }

        const choices = discovered
          .filter((w) => w.path && w.sources.some((s) => s.sessions > 0))
          .map((w) => {
            const sessions = w.sources.reduce((n, s) => n + s.sessions, 0);
            const agents = w.sources.map((s) => s.agent).join(', ');
            return {
              value: w.path,
              label: w.name,
              hint: `${sessions} sessions · ${agents}${w.initialized ? ' · indexed' : ''}`,
            };
          });

        if (choices.length === 0) {
          p.log.warn('No workspaces with transcripts found. Add a path manually.');
        }

        const picked = await p.multiselect({
          message: 'Select projects to index',
          options: choices,
          required: false,
        });
        if (p.isCancel(picked)) {
          p.cancel('Setup cancelled');
          process.exit(0);
        }
        selected = (picked as string[]) ?? [];

        const manual = await p.text({
          message: 'Add another project path (leave empty to continue)',
          placeholder: '/path/to/project',
        });
        if (!p.isCancel(manual) && manual && String(manual).trim()) {
          selected.push(resolve(String(manual).trim()));
        }
      }

      selected = [...new Set(selected.map((s) => resolve(s)))];
      if (selected.length === 0) {
        p.cancel('No projects selected');
        process.exit(1);
      }

      const plan = await buildSetupPlan(selected, { prose: opts.prose });

      if (opts.planOnly) {
        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
        } else {
          console.log(formatPlanTable(plan));
        }
        p.outro('Plan ready');
        return;
      }

      if (!opts.json) console.log('\n' + formatPlanTable(plan) + '\n');

      if (!opts.yes && isTTY()) {
        const action = await p.select({
          message: 'Continue?',
          options: [
            { value: 'run', label: 'Run full pipeline' },
            { value: 'back', label: 'Back — change project selection' },
            { value: 'cancel', label: 'Cancel' },
          ],
        });
        if (p.isCancel(action) || action === 'cancel') {
          p.cancel('Setup cancelled');
          process.exit(0);
        }
        if (action === 'back') {
          p.log.info('Re-run `subnet setup` to change selection.');
          process.exit(0);
        }
      }

      const s = p.spinner();
      let spinnerActive = false;
      const result = await runSetupPipeline({
        projects: selected,
        reprocess: opts.reprocess,
        verify: opts.verify,
        prose: opts.prose,
        skipDashboard: opts.skipDashboard,
        onProgress: (ev) => {
          if (!isTTY()) {
            if (ev.kind === 'stage') console.log(`[${ev.project ?? 'global'}] ${ev.stage}`);
            if (ev.kind === 'progress' && ev.total) {
              console.log(`  ${ev.project} ${ev.stage}: ${ev.current}/${ev.total}`);
            }
            if (ev.kind === 'projectDone') console.log(`${ev.project}: ${ev.ok ? 'ok' : 'failed'}`);
            return;
          }
          const label = (() => {
            if (ev.kind === 'stage') {
              return `${ev.project ? ev.project + ' — ' : ''}${ev.stage}`;
            }
            if (ev.kind === 'global') return `global — ${ev.stage}`;
            if (ev.kind === 'projectDone') {
              return ev.ok ? `${ev.project} done` : `${ev.project} failed`;
            }
            if (ev.kind === 'progress' && ev.total) {
              return `${ev.project} ${ev.stage} ${ev.current}/${ev.total}`;
            }
            return '';
          })();
          if (!label) return;
          if (!spinnerActive) {
            s.start(label);
            spinnerActive = true;
          } else {
            s.message(label);
          }
        },
      });

      if (spinnerActive) {
        s.stop();
        spinnerActive = false;
      }

      const failed = result.projects.filter((p) => !p.ok);
      for (const f of failed) {
        p.log.error(`${f.path}: ${f.error}`);
      }

      if (result.dashboardPath) {
        p.log.success(`Dashboard: ${result.dashboardPath}`);
        if (opts.open) openInBrowser(result.dashboardPath);
      }
      if (result.profilePath) {
        p.log.success(`Profile: ${result.profilePath}`);
      }

      p.outro(failed.length ? 'Setup finished with errors' : 'Cross-project skills. One local view.');
      if (failed.length) process.exit(1);
    });
}

function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}
