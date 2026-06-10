import type { Command } from 'commander';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { projectConfigDir, loadConfig } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { listProjectPaths } from '../global/clean.js';
import { listSkills, listIndustries } from '../global/skills.js';
import { rebuildLinks } from '../link/cross-project.js';
import { organizeKnowledge, listPara } from '../global/organize.js';
import { synthesizeWisdom, listWisdom } from '../global/wisdom.js';
import { locateBundle, buildGlobalDashboard } from '../dashboard/render.js';
import { buildGlobalSnapshot } from '../dashboard/global-snapshot.js';
import { writeProse } from './profile.js';
import '../agents/index.js';

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
    .description('Build the cross-project DIKW dashboard (Wisdom profile + knowledge map)')
    .option('--open', 'Open in browser when done', false)
    .option('--no-wisdom', 'Skip the L6 wisdom synthesis before building')
    .action(async (opts: { open: boolean; wisdom: boolean }) => {
      const bundle = locateBundle();
      if (!bundle) {
        console.error('Dashboard bundle not found. Run: npm run build:dashboard');
        process.exit(1);
      }
      // Organize (PARA) then synthesize wisdom first so the snapshot renders them.
      if (opts.wisdom) {
        const cfg = loadConfig();
        const gdb = openGlobalDb();
        try {
          const o = await organizeKnowledge(gdb, cfg);
          console.log(`PARA: ${o.active}/${o.projects} active · ${o.areas} areas · ${o.subjects} subjects · ${o.topics} topics (${o.source})`);
          for (const warn of o.warnings) console.log(`  ! ${warn}`);
          const w = await synthesizeWisdom(gdb, cfg);
          console.log(`Wisdom: ${w.insights} insights · ${w.gaps} gaps (${w.source})`);
          for (const warn of w.warnings) console.log(`  ! ${warn}`);
        } catch (e) {
          console.log(`Wisdom synthesis skipped: ${(e as Error).message}`);
        } finally {
          gdb.close();
        }
      }
      const indexPath = buildGlobalDashboard(bundle);
      const c = buildGlobalSnapshot().meta.counts;
      console.log('Global dashboard written:');
      console.log(`  ${indexPath}`);
      console.log(`  industries=${c.industries} businessDomains=${c.businessDomains} techDomains=${c.techDomains} projects=${c.projects}`);
      if (opts.open) openInBrowser(indexPath);
    });

  g.command('wisdom')
    .description('Organize knowledge (PARA) + synthesize wisdom: projects, areas, subjects/topics, insights, gaps')
    .option('--json', 'Print the full PARA + wisdom snapshot as JSON', false)
    .action(async (opts: { json: boolean }) => {
      const cfg = loadConfig();
      const gdb = openGlobalDb();
      try {
        const orgStats = await organizeKnowledge(gdb, cfg);
        const wisStats = await synthesizeWisdom(gdb, cfg);
        const para = listPara(gdb);
        const w = listWisdom(gdb);
        if (opts.json) {
          console.log(JSON.stringify({ wisdom: w, para }, null, 2));
          return;
        }
        if (!w.headline && para.areas.length === 0 && para.subjects.length === 0) {
          console.log('No knowledge yet. Run `subnet update --global` across your projects first.');
          return;
        }
        if (w.headline) console.log(`# ${w.headline}\n`);
        if (w.narrative) console.log(`${w.narrative}\n`);

        console.log(`## Projects (${para.projects.length} active · ${para.archives.length} archived)`);
        for (const p of para.projects.slice(0, 20)) console.log(`  - ${p.name}${p.focus ? ` — ${p.focus}` : ''}`);

        console.log('\n## Areas (ongoing competencies)');
        for (const a of para.areas) {
          console.log(`  - [${a.level}] ${a.name}  (w=${a.weight.toFixed(1)}, ×${a.projectCount})`);
          if (a.skills.length) console.log(`      ${a.skills.slice(0, 12).map((s) => s.name).join(', ')}`);
        }

        console.log('\n## Resources (subjects → topics)');
        for (const s of para.subjects) {
          console.log(`  - ${s.name}`);
          for (const t of s.topics.slice(0, 8)) console.log(`      • ${t.name} (${t.items.length})`);
        }

        if (w.insights.length) {
          console.log('\n## Insights');
          for (const i of w.insights) console.log(`  - (${i.kind}) ${i.title}`);
        }

        if (w.gaps.length) {
          console.log('\n## Gaps to close');
          for (const gp of w.gaps) {
            console.log(`  - [${gp.severity ?? 'n/a'}] ${gp.title}`);
            if (gp.recommendation) console.log(`      → ${gp.recommendation}`);
          }
        }

        console.log(`\nGrounding: model (inference) · organize: ${orgStats.source} · wisdom: ${wisStats.source}`);
        for (const warn of [...orgStats.warnings, ...wisStats.warnings]) console.log(`! ${warn}`);
      } finally {
        gdb.close();
      }
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
