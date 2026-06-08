/**
 * Interactive menu — the default experience when `subnet` is run with no
 * subcommand in a TTY. Menu-driven flows built on @clack/prompts; every action
 * routes through the same service layer the CLI commands use (no shelling out).
 */
import { resolve } from 'path';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { ensureGlobalConfig, globalConfigDir } from '../config.js';
import { registeredProjects } from '../app/projects.js';
import { runUpdate, isUnhealthy } from '../app/update.js';
import { collectDoctorReport, runDoctorFixes } from '../app/doctor.js';
import type { RunProfile } from '../pipeline/run-project.js';
import { locateBundle, buildProjectDashboard, buildGlobalDashboard } from '../dashboard/render.js';
import { openGlobalDb } from '../db/connection.js';
import { listIndustries, listSkills } from '../global/skills.js';

// @clack/prompts is loaded via dynamic import (ESM-only). Typed loosely here to
// avoid a CommonJS `typeof import(...)` type expression.
type Clack = any;

export async function runInteractiveMenu(): Promise<void> {
  ensureGlobalConfig();
  const p = await import('@clack/prompts');
  p.intro('subnet — cross-project knowledge graph');

  for (;;) {
    const projects = registeredProjects();
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'update', label: 'Update', hint: `${projects.filter((x) => x.initialized).length} project(s) indexed` },
        { value: 'setup', label: 'Add / index projects' },
        { value: 'doctor', label: 'Health check' },
        { value: 'dashboard', label: 'Open a dashboard' },
        { value: 'insights', label: 'Insights (profile + skills)' },
        { value: 'watch', label: 'Watch daemon (status)' },
        { value: 'advanced', label: 'Advanced commands' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (p.isCancel(action) || action === 'quit') {
      p.outro('Bye.');
      return;
    }

    try {
      switch (action) {
        case 'update': await updateFlow(p, projects); break;
        case 'setup': await setupFlow(p); break;
        case 'doctor': await doctorFlow(p); break;
        case 'dashboard': await dashboardFlow(p, projects); break;
        case 'insights': await insightsFlow(p); break;
        case 'watch': await watchFlow(p); break;
        case 'advanced': await advancedFlow(p); break;
      }
    } catch (e) {
      p.log.error((e as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------

async function updateFlow(p: Clack, projects: ReturnType<typeof registeredProjects>): Promise<void> {
  const initialized = projects.filter((x) => x.initialized);
  if (initialized.length === 0) {
    p.log.warn('No indexed projects yet. Use "Add / index projects" first.');
    return;
  }

  const scope = await p.select({
    message: 'Which projects?',
    options: [
      { value: 'all', label: `All (${initialized.length})` },
      { value: 'pick', label: 'Choose…' },
    ],
  });
  if (p.isCancel(scope)) return;

  let targets = initialized.map((x) => x.path);
  if (scope === 'pick') {
    const picked = await p.multiselect({
      message: 'Select projects',
      options: initialized.map((x) => ({ value: x.path, label: x.name, hint: x.path })),
      required: true,
    });
    if (p.isCancel(picked)) return;
    targets = picked as string[];
  }

  const profile = await p.select({
    message: 'Profile',
    options: [
      { value: 'fast', label: 'Fast', hint: 'transcripts only; skip analysis + enrichment' },
      { value: 'default', label: 'Standard', hint: 'incremental; tier-1 analyze + fused enrich' },
      { value: 'deep', label: 'Deep', hint: 'all files + legacy enrich (no reprocess)' },
      { value: 'full', label: 'Full', hint: 'deep + reprocess all windows' },
    ],
    initialValue: 'default',
  });
  if (p.isCancel(profile)) return;

  const spin = p.spinner();
  spin.start('Updating…');
  const result = await runUpdate({
    projects: targets,
    profile: profile as RunProfile,
    global: true,
    onProgress: (ev) => {
      if (ev.kind === 'stage') spin.message(`${ev.project ?? 'global'} — ${ev.stage}`);
      else if (ev.kind === 'global') spin.message(`global — ${ev.stage}`);
      else if (ev.kind === 'progress' && ev.total) spin.message(`${ev.project} ${ev.stage} ${ev.current}/${ev.total}`);
    },
  });
  spin.stop('Update complete.');

  if (!result.locked) {
    p.log.warn('Another update is already running (lock held).');
    return;
  }
  for (const r of result.projects) {
    const note = r.failures > 0 ? ` · ${r.failures}/${r.runs} agent failures` : '';
    p.log[r.ok ? 'success' : 'error'](`${r.name}: ${r.ok ? 'ok' : 'failed'} (${Math.round(r.durationMs / 1000)}s)${note}`);
  }
  for (const w of result.globalWarnings) p.log.warn(w);
  if (result.projects.some(isUnhealthy)) p.log.warn('Some projects look unhealthy — run a Health check.');
}

async function setupFlow(p: Clack): Promise<void> {
  const { discoverWorkspaces } = await import('../setup/discover.js');
  const { runSetupPipeline } = await import('../setup/run.js');

  const spin = p.spinner();
  spin.start('Discovering workspaces…');
  const discovered = await discoverWorkspaces({});
  spin.stop(`Found ${discovered.length} workspace(s).`);

  const choices = discovered
    .filter((w) => w.path && w.sources.some((s) => s.sessions > 0))
    .map((w) => ({
      value: w.path,
      label: w.name,
      hint: `${w.sources.reduce((n, s) => n + s.sessions, 0)} sessions${w.initialized ? ' · indexed' : ''}`,
    }));

  let selected: string[] = [];
  if (choices.length > 0) {
    const picked = await p.multiselect({ message: 'Select projects to index', options: choices, required: false });
    if (p.isCancel(picked)) return;
    selected = picked as string[];
  } else {
    p.log.warn('No workspaces with transcripts auto-discovered.');
  }

  const manual = await p.text({ message: 'Add a project path (empty to skip)', placeholder: '/path/to/project' });
  if (!p.isCancel(manual) && manual && String(manual).trim()) selected.push(resolve(String(manual).trim()));

  selected = [...new Set(selected.map((s) => resolve(s)))];
  if (selected.length === 0) {
    p.log.warn('Nothing selected.');
    return;
  }

  const spin2 = p.spinner();
  spin2.start('Indexing (full pipeline)…');
  const result = await runSetupPipeline({
    projects: selected,
    onProgress: (ev) => {
      if (ev.kind === 'stage') spin2.message(`${ev.project ?? 'global'} — ${ev.stage}`);
      else if (ev.kind === 'global') spin2.message(`global — ${ev.stage}`);
      else if (ev.kind === 'progress' && ev.total) spin2.message(`${ev.project} ${ev.stage} ${ev.current}/${ev.total}`);
    },
  });
  spin2.stop('Indexing complete.');
  for (const pr of result.projects) p.log[pr.ok ? 'success' : 'error'](`${pr.path}: ${pr.ok ? 'ok' : pr.error}`);
  if (result.dashboardPath) p.log.success(`Dashboard: ${result.dashboardPath}`);
}

async function doctorFlow(p: Clack): Promise<void> {
  const report = collectDoctorReport();
  for (const f of report.findings) p.log.error(f);
  for (const w of report.warnings) p.log.warn(w);
  if (report.health.length === 0) {
    p.log.info('No indexed projects to inspect.');
  } else {
    for (const h of report.health) {
      const rate = h.recentRuns > 0 ? Math.round((h.recentFailures / h.recentRuns) * 100) : 0;
      const drift = h.modelDrift ? ' · model config changed' : '';
      const a = h.pipelineAudit;
      const audit = [
        a.windowsMechanicalDup ? `dupWin=${a.windowsMechanicalDup}` : '',
        a.factsAnchorRejected ? `anchorRej=${a.factsAnchorRejected}` : '',
        a.filesAnalyzeSkippedTier ? `skipAnalyze=${a.filesAnalyzeSkippedTier}` : '',
      ].filter(Boolean).join(' ');
      p.log.info(`${h.name}: unclustered=${h.unclusteredFacts} missingSummaries=${h.conceptsMissingSummary} pendingFiles=${h.pendingFiles} failures=${rate}%${drift}${audit ? ` audit[${audit}]` : ''}`);
    }
  }

  const needsFix = report.health.some((h) => h.conceptsMissingSummary > 0);
  if (!needsFix) return;
  const fix = await p.confirm({ message: 'Repair missing summaries + re-link + rebuild dashboards?', initialValue: false });
  if (p.isCancel(fix) || !fix) return;

  const spin = p.spinner();
  spin.start('Repairing…');
  const result = await runDoctorFixes();
  spin.stop('Repair complete.');
  for (const pr of result.perProject) if (pr.attempted > 0) p.log.success(`${pr.path}: ${pr.summarized}/${pr.attempted} summaries`);
  for (const w of result.globalWarnings) p.log.warn(w);
}

async function dashboardFlow(p: Clack, projects: ReturnType<typeof registeredProjects>): Promise<void> {
  const bundle = locateBundle();
  if (!bundle) {
    p.log.error('Dashboard bundle not found. Run `npm run build:dashboard`.');
    return;
  }
  const initialized = projects.filter((x) => x.initialized);
  const target = await p.select({
    message: 'Which dashboard?',
    options: [
      { value: '__global__', label: 'Global (cross-project)' },
      ...initialized.map((x) => ({ value: x.path, label: x.name })),
    ],
  });
  if (p.isCancel(target)) return;

  const spin = p.spinner();
  spin.start('Building…');
  const indexPath = target === '__global__' ? buildGlobalDashboard(bundle) : buildProjectDashboard(bundle, target as string);
  spin.stop(`Built: ${indexPath}`);

  const open = await p.confirm({ message: 'Open in browser?', initialValue: true });
  if (!p.isCancel(open) && open) openInBrowser(indexPath);
}

async function insightsFlow(p: Clack): Promise<void> {
  const gdb = openGlobalDb();
  try {
    const projectCount = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;
    const industries = listIndustries(gdb);
    const skills = listSkills(gdb, { scope: 'technical', limit: 15 });
    p.log.info(`Projects indexed: ${projectCount}`);
    p.log.info(`Industries: ${industries.length ? industries.map((i) => i.name).join(', ') : '(none classified)'}`);
    if (skills.length === 0) p.log.info('Top skills: (none yet)');
    else p.log.info('Top skills:\n' + skills.map((s) => `  • ${s.name} (w=${s.evidenceWeight.toFixed(1)}, ×${s.projectCount})`).join('\n'));
  } finally {
    gdb.close();
  }
}

async function watchFlow(p: Clack): Promise<void> {
  const pidPath = join(globalConfigDir(), 'watch.pid');
  let running = false;
  let pid: number | undefined;
  if (existsSync(pidPath)) {
    pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    try { process.kill(pid, 0); running = true; } catch { running = false; }
  }
  if (running) {
    p.log.info(`Watch daemon running (pid ${pid}). Stop it with: subnet watch --stop`);
  } else {
    p.log.info('Watch daemon not running. Start it with: subnet watch');
  }
}

async function advancedFlow(p: Clack): Promise<void> {
  p.note(
    [
      'Per-stage + maintenance commands (run directly):',
      '  subnet sync | ingest | analyze | enrich      project pipeline stages',
      '  subnet status | verify | triage audit         inspect / clean knowledge',
      '  subnet global link | dashboard | profile | skills',
      '  subnet serve --mcp                             MCP server',
      '  subnet canvas <kind> | agents <list|eval|run>  tooling',
      '  subnet clean [--all]                           remove project / global data',
      '  subnet watch [--stop]                          automation daemon',
    ].join('\n'),
    'Advanced',
  );
}

function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}
