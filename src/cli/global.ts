import type { Command } from 'commander';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { projectConfigDir } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { listProjectPaths } from '../global/clean.js';
import { listSkills, listIndustries } from '../global/skills.js';
import { rebuildLinks } from '../link/cross-project.js';
import { locateBundle, buildGlobalDashboard } from '../dashboard/render.js';
import { buildGlobalSnapshot } from '../dashboard/global-snapshot.js';
import { writeProse } from './profile.js';

/**
 * `subnet global ...` — cross-project operations on ~/.substrate-net/global.db.
 * Replaces the top-level `link` / `dashboard --global` / `profile` / `skills`
 * commands (which remain as deprecated aliases).
 */
export function registerGlobal(program: Command): void {
  const g = program.command('global').description('Cross-project (global) operations on ~/.substrate-net');

  g.command('link')
    .description('Rebuild cross-project links + global skill graph (L4/L5)')
    .argument('[path]', 'Project root to export (default: every registered project)')
    .option('--all', 'Re-link every registered project', false)
    .option('--rebuild', 'Full recompute instead of incremental', false)
    .action(async (path: string | undefined, opts: { all: boolean; rebuild: boolean }) => {
      const targets = path && !opts.all ? [resolve(path)] : registeredPaths();
      for (const root of targets) {
        const stats = await rebuildLinks(root, { full: opts.rebuild });
        console.log(`Linked ${root}:`);
        console.log(`  Concepts ${stats.exported} · mech ${stats.mechanical} · agent ${stats.semantic} · ` +
          `skills ${stats.skills} (${stats.crossProjectSkills} cross) · biz ${stats.businessDomains} · tech ${stats.techDomains}`);
      }
    });

  g.command('dashboard')
    .description('Build the cross-project hierarchy dashboard')
    .option('--open', 'Open in browser when done', false)
    .action(async (opts: { open: boolean }) => {
      const bundle = locateBundle();
      if (!bundle) {
        console.error('Dashboard bundle not found. Run: npm run build:dashboard');
        process.exit(1);
      }
      const indexPath = buildGlobalDashboard(bundle);
      const c = buildGlobalSnapshot().meta.counts;
      console.log('Global dashboard written:');
      console.log(`  ${indexPath}`);
      console.log(`  industries=${c.industries} businessDomains=${c.businessDomains} techDomains=${c.techDomains} projects=${c.projects}`);
      if (opts.open) openInBrowser(indexPath);
    });

  g.command('profile')
    .description('Cross-project knowledge profile (industries + top skills)')
    .option('--prose', 'Generate portfolio prose via the ProfileWriter agent', false)
    .option('--out <path>', 'Where to write prose markdown')
    .action(async (opts: { prose: boolean; out?: string }) => {
      if (opts.prose) {
        const { globalConfigDir } = await import('../config.js');
        const { join } = await import('path');
        return writeProse(opts.out ?? join(globalConfigDir(), 'profile.md'));
      }
      const gdb = openGlobalDb();
      try {
        const projectCount = (gdb.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as any).n;
        const industries = listIndustries(gdb);
        const tech = listSkills(gdb, { scope: 'technical', limit: 20 });
        console.log(`# Knowledge profile\n\nProjects indexed: ${projectCount}\n`);
        console.log('## Industries');
        if (industries.length === 0) console.log('  (none classified)');
        for (const i of industries) console.log(`  - ${i.name} (${i.projectCount} project${i.projectCount === 1 ? '' : 's'})`);
        console.log('\n## Top technical skills');
        for (const s of tech) console.log(`  - ${s.name} (w=${s.evidenceWeight.toFixed(1)}, ×${s.projectCount})`);
      } finally {
        gdb.close();
      }
    });

  g.command('skills')
    .description('Global skill graph weighted by evidence across projects')
    .option('--scope <s>', 'Filter: technical | industry')
    .option('--cross', 'Only skills present in more than one project', false)
    .option('--limit <n>', 'Max rows', '60')
    .action(async (opts: { scope?: string; cross: boolean; limit: string }) => {
      const gdb = openGlobalDb();
      try {
        const skills = listSkills(gdb, { scope: opts.scope, crossOnly: opts.cross, limit: parseInt(opts.limit, 10) });
        if (skills.length === 0) {
          console.log('No skills yet. Run `subnet update` across your projects first.');
          return;
        }
        for (const s of skills) {
          console.log(`${s.evidenceWeight.toFixed(1).padStart(6)}  ${s.grounding.padEnd(12)} ${('×' + s.projectCount).padStart(4)}  ${s.name}`);
        }
        console.log(`\n${skills.length} skill(s)`);
      } finally {
        gdb.close();
      }
    });
}

function registeredPaths(): string[] {
  const gdb = openGlobalDb();
  try {
    return listProjectPaths(gdb).map((p) => p.path).filter((p) => existsSync(projectConfigDir(p)));
  } finally {
    gdb.close();
  }
}

function openInBrowser(file: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}
