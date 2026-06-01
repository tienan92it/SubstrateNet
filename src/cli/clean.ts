import type { Command } from 'commander';
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { projectConfigDir, globalConfigDir } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { cleanGlobalProject, countGlobalProject, listProjectPaths } from '../global/clean.js';

export function registerClean(program: Command): void {
  program
    .command('clean')
    .description('Remove a project\'s knowledge: local .substrate-net/ and/or its rows in the global brain')
    .argument('[path]', 'Project root path', '.')
    .option('--local-only', 'Only delete the local .substrate-net/ directory', false)
    .option('--global-only', 'Only delete this project\'s rows in ~/.substrate-net/global.db', false)
    .option('--all', 'Reset everything: every registered project\'s local data + the global brain (keeps config.json)', false)
    .option('-y, --yes', 'Skip the confirmation dry-run and actually delete', false)
    .action(async (path: string, opts: { localOnly: boolean; globalOnly: boolean; all: boolean; yes: boolean }) => {
      if (opts.all) return cleanAll(opts.yes);

      const root = resolve(path);
      const localDir = projectConfigDir(root);
      const doLocal = !opts.globalOnly;
      const doGlobal = !opts.localOnly;

      // Inspect what would be removed.
      const localExists = existsSync(localDir);
      let counts: ReturnType<typeof countGlobalProject> | undefined;
      if (doGlobal) {
        const gdb = openGlobalDb();
        try { counts = countGlobalProject(gdb, root); } finally { gdb.close(); }
      }

      console.log(`Clean plan for ${root}:`);
      if (doLocal) console.log(`  local:  ${localExists ? `remove ${localDir}` : '(no .substrate-net/ — nothing to remove)'}`);
      if (doGlobal && counts) {
        console.log(`  global: ${counts.found ? `remove project ${counts.projectId}` : '(not registered globally)'}`);
        console.log(`            concepts=${counts.conceptsGlobal} links=${counts.conceptLinks} skillEvidence=${counts.skillEvidence} industries=${counts.industries}`);
      }

      if (!opts.yes) {
        console.log(`\nDry run. Re-run with --yes to actually delete.`);
        return;
      }

      if (doLocal && localExists) {
        rmSync(localDir, { recursive: true, force: true });
        console.log(`Removed ${localDir}`);
      }
      if (doGlobal) {
        const gdb = openGlobalDb();
        try {
          const removed = cleanGlobalProject(gdb, root);
          console.log(`Global rows removed (concepts=${removed.conceptsGlobal}, skillEvidence=${removed.skillEvidence}, industries=${removed.industries}); skill graph re-aggregated.`);
        } finally { gdb.close(); }
      }
      console.log('Done.');
    });
}

function cleanAll(yes: boolean): void {
  const gdb = openGlobalDb();
  let projects: Array<{ id: string; name: string; path: string }> = [];
  try { projects = listProjectPaths(gdb); } finally { gdb.close(); }

  const globalFiles = ['global.db', 'global.db-wal', 'global.db-shm'].map((f) => join(globalConfigDir(), f));

  console.log('Clean plan: FULL RESET');
  console.log(`  global brain: remove ${globalFiles.filter(existsSync).join(', ') || '(none)'}`);
  console.log(`  local dirs:   ${projects.length} registered project(s)`);
  for (const p of projects) console.log(`    - ${join(p.path, '.substrate-net')}`);
  console.log(`  config.json is preserved.`);

  if (!yes) {
    console.log(`\nDry run. Re-run with --all --yes to actually delete.`);
    return;
  }

  for (const p of projects) {
    const dir = join(p.path, '.substrate-net');
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log(`Removed ${dir}`); }
  }
  for (const f of globalFiles) if (existsSync(f)) rmSync(f, { force: true });
  console.log('Global brain wiped. Done.');
}
