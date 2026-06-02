import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ensureGlobalConfig, projectConfigDir } from '../config.js';
import { openCodeDb, openKnowledgeDb, openGlobalDb } from '../db/connection.js';
import { registerProject } from '../global/registry.js';

/** Ensure `.substrate-net/` exists and the project is registered globally. */
export function ensureProjectInitialized(root: string): string {
  const abs = resolve(root);
  const cfgDir = projectConfigDir(abs);
  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });

  const cfgPath = join(cfgDir, 'config.json');
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, JSON.stringify({ agents: {} }, null, 2));
  }

  ensureGlobalConfig();
  openCodeDb(abs).close();
  openKnowledgeDb(abs).close();

  const gdb = openGlobalDb();
  registerProject(gdb, abs);
  gdb.close();

  return cfgDir;
}
