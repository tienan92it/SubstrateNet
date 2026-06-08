/**
 * Shared project-list resolution.
 *
 * One source of truth for "which projects does this command act on?", used by
 * the CLI commands (update/doctor/watch) and the interactive menu.
 */
import { resolve } from 'path';
import { existsSync } from 'fs';
import { projectConfigDir } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { listProjectPaths } from '../global/clean.js';

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  /** Whether the local .substrate-net/ index still exists on disk. */
  initialized: boolean;
}

/** All projects registered in global.db, with on-disk init status. */
export function registeredProjects(): RegisteredProject[] {
  const gdb = openGlobalDb();
  try {
    return listProjectPaths(gdb).map((p) => ({
      ...p,
      initialized: existsSync(projectConfigDir(p.path)),
    }));
  } finally {
    gdb.close();
  }
}

/** Initialized registered project paths (skip stale/uninitialized entries). */
export function initializedProjectPaths(): string[] {
  return registeredProjects().filter((p) => p.initialized).map((p) => p.path);
}

/**
 * Resolve the target list for a command: an explicit path (single project),
 * or every initialized registered project when no path is given.
 */
export function resolveTargetProjects(path?: string): string[] {
  if (path) return [resolve(path)];
  return initializedProjectPaths();
}
