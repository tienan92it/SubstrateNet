/**
 * Update orchestration shared by `subnet update` and the interactive menu.
 * Owns the lock, the serial per-project loop, global aggregation, and the
 * last-run record so callers (CLI + TUI) stay thin and consistent.
 */
import { existsSync } from 'fs';
import { projectConfigDir } from '../config.js';
import { openKnowledgeDb } from '../db/connection.js';
import { runProjectPipeline, type RunProfile, type RunProjectResult } from '../pipeline/run-project.js';
import { runGlobalPipeline } from '../pipeline/run-global.js';
import { writeLastRun } from '../setup/last-run.js';
import { acquireLock } from '../util/lock.js';
import type { SetupProgressFn } from '../setup/types.js';

export interface UpdateOptions {
  projects: string[];
  profile: RunProfile;
  global?: boolean;
  dashboard?: boolean;
  verify?: boolean;
  invalidateCache?: boolean;
  onProgress?: SetupProgressFn;
  onProjectDone?: (r: RunProjectResult) => void;
}

export interface UpdateResult {
  /** False when another update holds the lock; nothing ran. */
  locked: boolean;
  projects: RunProjectResult[];
  globalWarnings: string[];
  globalDashboardPath?: string;
}

/** A completed run is "unhealthy" if it failed outright or had a high failure rate. */
export function isUnhealthy(r: RunProjectResult): boolean {
  return !r.ok || (r.runs >= 20 && r.failures / r.runs > 0.05);
}

export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const dashboard = opts.dashboard !== false;
  const release = acquireLock('update');
  if (!release) return { locked: false, projects: [], globalWarnings: [] };

  const results: RunProjectResult[] = [];
  try {
    if (opts.invalidateCache) {
      for (const root of opts.projects) invalidateProjectCache(root);
    }
    for (const root of opts.projects) {
      const r = await runProjectPipeline(root, {
        profile: opts.profile,
        verify: opts.verify,
        syncFull: opts.profile === 'full',
        onProgress: opts.onProgress,
      });
      results.push(r);
      opts.onProjectDone?.(r);
    }

    const okPaths = results.filter((r) => r.ok).map((r) => r.path);
    let globalWarnings: string[] = [];
    let globalDashboardPath: string | undefined;
    if (okPaths.length > 0) {
      const global = await runGlobalPipeline({
        projects: okPaths,
        linkAllProjects: false,
        globalDashboard: opts.global && dashboard,
        projectDashboard: dashboard,
        onProgress: opts.onProgress,
      });
      globalWarnings = global.warnings;
      globalDashboardPath = global.globalDashboardPath;
    }

    writeLastRun({
      at: new Date().toISOString(),
      command: 'update',
      profile: opts.profile,
      projects: results.map((r) => ({ path: r.path, name: r.name, ok: r.ok, error: r.error, stages: r.stages, durationMs: r.durationMs })),
      globalDashboardPath,
    });

    return { locked: true, projects: results, globalWarnings, globalDashboardPath };
  } finally {
    release();
  }
}

/** Clear cached agent runs so a model change forces fresh calls. */
function invalidateProjectCache(root: string): void {
  if (!existsSync(projectConfigDir(root))) return;
  const db = openKnowledgeDb(root);
  try {
    db.prepare(`DELETE FROM agent_runs`).run();
  } finally {
    db.close();
  }
}
