import { ensureGlobalConfig } from '../config.js';
import { runProjectPipeline } from '../pipeline/run-project.js';
import { runProfileFromSetup } from '../pipeline/profile.js';
import { runGlobalPipeline } from '../pipeline/run-global.js';
import { writeLastRun } from './last-run.js';
import type { SetupRunOpts, SetupRunResult } from './types.js';
import type { AgentId } from '../types.js';

export async function runSetupPipeline(
  opts: SetupRunOpts & { agentFilter?: AgentId; profile?: string },
): Promise<SetupRunResult> {
  ensureGlobalConfig();
  const profile = runProfileFromSetup({ profile: opts.profile, reprocess: opts.reprocess });
  const result: SetupRunResult = { projects: [] };

  const projectResults = [];
  for (const raw of opts.projects) {
    const pr = await runProjectPipeline(raw, {
      profile,
      agentFilter: opts.agentFilter,
      verify: opts.verify,
      syncFull: opts.reprocess,
      onProgress: opts.onProgress,
    });
    projectResults.push(pr);
    result.projects.push({ path: pr.path, ok: pr.ok, error: pr.error });
  }

  const okPaths = projectResults.filter((p) => p.ok).map((p) => p.path);
  if (okPaths.length > 0) {
    const global = await runGlobalPipeline({
      projects: okPaths,
      linkAllProjects: true,
      prose: opts.prose,
      globalDashboard: !opts.skipDashboard,
      projectDashboard: !opts.skipDashboard,
      onProgress: opts.onProgress,
    });
    result.dashboardPath = global.globalDashboardPath
      ?? global.projectDashboardPaths[global.projectDashboardPaths.length - 1];
    result.profilePath = global.profilePath;
  }

  writeLastRun({
    at: new Date().toISOString(),
    command: 'setup',
    profile,
    projects: projectResults.map((p) => ({
      path: p.path, name: p.name, ok: p.ok, error: p.error,
      stages: p.stages, durationMs: p.durationMs,
    })),
    globalDashboardPath: result.dashboardPath,
    profilePath: result.profilePath,
  });

  return result;
}
