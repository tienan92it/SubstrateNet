import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ensureGlobalConfig, projectConfigDir } from '../config.js';
import { openCodeDb, openKnowledgeDb, openGlobalDb } from '../db/connection.js';
import { registerProject } from '../global/registry.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize .substrate-net/ in the current (or specified) project')
    .argument('[path]', 'Project root path', '.')
    .action(async (path: string) => {
      const root = resolve(path);
      const cfgDir = projectConfigDir(root);
      if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });

      const cfgPath = join(cfgDir, 'config.json');
      if (!existsSync(cfgPath)) {
        writeFileSync(
          cfgPath,
          JSON.stringify(
            {
              // Per-project override; empty by default — uses global config.
              agents: {},
            },
            null, 2,
          ),
        );
      }

      ensureGlobalConfig();
      openCodeDb(root).close();
      openKnowledgeDb(root).close();

      const gdb = openGlobalDb();
      registerProject(gdb, root);
      gdb.close();

      console.log(`Initialized Substrate Net at ${cfgDir}`);
    });
}
