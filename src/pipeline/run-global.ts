/**
 * Shared global (cross-project) pipeline runner.
 *
 * Fixes the multi-project gap in the old setup flow, which exported only the
 * first successful project into global.db. Here every requested project is
 * linked (serial), then the global skill graph + dashboards are rebuilt.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { globalConfigDir, projectConfigDir, loadConfig } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { listProjectPaths } from '../global/clean.js';
import { rebuildLinks } from '../link/cross-project.js';
import { synthesizeWisdom } from '../global/wisdom.js';
import {
  locateBundle,
  buildProjectDashboard,
  buildGlobalDashboard,
} from '../dashboard/render.js';
import type { SetupProgressFn } from '../setup/types.js';

export interface RunGlobalOpts {
  /** Projects to export + link. Ignored when linkAllProjects is true. */
  projects: string[];
  /** Link every registered project in global.db (serial), not just `projects`. */
  linkAllProjects?: boolean;
  /** Generate portfolio prose at ~/.substrate-net/profile.md. */
  prose?: boolean;
  /**
   * Synthesize the L6 wisdom layer (competencies, insights, gaps) into
   * global.db. Defaults to whatever `globalDashboard` is, since the dashboard
   * renders it; pass `false` to skip the LLM synthesis explicitly.
   */
  wisdom?: boolean;
  /** Rebuild the cross-project hierarchy dashboard. */
  globalDashboard?: boolean;
  /** Rebuild each linked project's dashboard. */
  projectDashboard?: boolean;
  onProgress?: SetupProgressFn;
}

export interface RunGlobalResult {
  linked: string[];
  globalDashboardPath?: string;
  projectDashboardPaths: string[];
  profilePath?: string;
  /** Non-fatal failures (e.g. semantic linking backend down). */
  warnings: string[];
}

export async function runGlobalPipeline(opts: RunGlobalOpts): Promise<RunGlobalResult> {
  const result: RunGlobalResult = { linked: [], projectDashboardPaths: [], warnings: [] };
  const emit = (stage: string) => opts.onProgress?.({ kind: 'global', stage });

  // Resolve which projects to link.
  let targets = opts.projects;
  if (opts.linkAllProjects) {
    const gdb = openGlobalDb();
    try {
      targets = listProjectPaths(gdb).map((p) => p.path);
    } finally {
      gdb.close();
    }
  }
  targets = [...new Set(targets)].filter((p) => existsSync(projectConfigDir(p)));

  // Link each project (serial). rebuildLinks exports `root` then aggregates the
  // whole registry, so the final pass reflects all projects.
  for (const path of targets) {
    emit('link');
    try {
      const stats = await rebuildLinks(path, { full: false });
      result.linked.push(path);
      for (const w of stats.warnings ?? []) result.warnings.push(`${path}: ${w}`);
    } catch (e) {
      result.warnings.push(`link failed for ${path}: ${(e as Error).message}`);
    }
  }

  if (opts.prose) {
    emit('profile');
    result.profilePath = join(globalConfigDir(), 'profile.md');
    try {
      const { writeProse } = await import('../cli/profile.js');
      await writeProse(result.profilePath);
    } catch (e) {
      result.warnings.push(`prose generation failed: ${(e as Error).message}`);
      result.profilePath = undefined;
    }
  }

  // L6 wisdom synthesis feeds the global dashboard, so run it by default
  // whenever that dashboard is being (re)built. Cached + deterministically
  // backstopped, so it is cheap on no-change re-runs.
  const wantWisdom = (opts.wisdom ?? opts.globalDashboard ?? false) && result.linked.length > 0;
  if (wantWisdom) {
    emit('wisdom');
    const gdb = openGlobalDb();
    try {
      const w = await synthesizeWisdom(gdb, loadConfig());
      for (const warn of w.warnings) result.warnings.push(warn);
    } catch (e) {
      result.warnings.push(`wisdom synthesis failed: ${(e as Error).message}`);
    } finally {
      gdb.close();
    }
  }

  const needBundle = (opts.projectDashboard || opts.globalDashboard) && result.linked.length > 0;
  if (needBundle) {
    const bundleDir = locateBundle();
    if (!bundleDir) {
      result.warnings.push('Dashboard bundle not found; run `npm run build:dashboard`.');
    } else {
      if (opts.projectDashboard) {
        for (const path of result.linked) {
          emit('dashboard');
          try {
            result.projectDashboardPaths.push(buildProjectDashboard(bundleDir, path));
          } catch (e) {
            result.warnings.push(`dashboard failed for ${path}: ${(e as Error).message}`);
          }
        }
      }
      if (opts.globalDashboard) {
        emit('dashboard');
        try {
          result.globalDashboardPath = buildGlobalDashboard(bundleDir);
        } catch (e) {
          result.warnings.push(`global dashboard failed: ${(e as Error).message}`);
        }
      }
    }
  }

  return result;
}
