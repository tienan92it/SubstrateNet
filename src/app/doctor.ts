/**
 * Health diagnostics + repair, decoupled from the CLI so both `subnet doctor`
 * and the interactive menu can use them.
 */
import { existsSync } from 'fs';
import { loadConfig, projectConfigDir, configModelFingerprint } from '../config.js';
import { validateConfig } from '../config/validate.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { getPipelineState } from '../knowledge/pipeline-state.js';
import { repairConceptSummaries } from '../pipeline/cluster.js';
import { runGlobalPipeline } from '../pipeline/run-global.js';
import { readLastRun } from '../setup/last-run.js';
import { locateBundle } from '../dashboard/render.js';
import { registeredProjects, resolveTargetProjects } from './projects.js';

export interface ProjectHealth {
  path: string;
  name: string;
  unclusteredFacts: number;
  conceptsMissingSummary: number;
  pendingFiles: number;
  recentFailures: number;
  recentRuns: number;
  modelDrift: boolean;
}

export interface DoctorReport {
  findings: string[];   // errors
  warnings: string[];
  health: ProjectHealth[];
  lastRunAt?: string;
}

/** Run all read-only health checks for the given scope (path or all registered). */
export function collectDoctorReport(path?: string): DoctorReport {
  const findings: string[] = [];
  const warnings: string[] = [];

  for (const f of validateConfig(loadConfig())) {
    (f.level === 'error' ? findings : warnings).push(`config: ${f.message}`);
  }

  const health: ProjectHealth[] = [];
  for (const root of resolveTargetProjects(path)) {
    if (!existsSync(root)) continue; // stale registry path, flagged below
    if (!existsSync(projectConfigDir(root))) {
      findings.push(`project ${root}: not initialized (run \`subnet update ${root}\`)`);
      continue;
    }
    health.push(inspectProject(root));
  }

  if (!locateBundle()) warnings.push('dashboard bundle missing; run `npm run build:dashboard`.');
  for (const p of registeredProjects()) {
    if (!existsSync(p.path)) warnings.push(`registry path no longer exists: ${p.path}`);
  }

  const last = readLastRun();
  if (last) {
    const ageH = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
    if (ageH > 24) warnings.push(`last ${last.command ?? 'pipeline'} run was ${Math.round(ageH)}h ago; consider \`subnet update\`.`);
  } else {
    warnings.push('no recorded setup/update run; run `subnet setup` or `subnet update`.');
  }

  return { findings, warnings, health, lastRunAt: last?.at };
}

export function inspectProject(root: string): ProjectHealth {
  const knowDb = openKnowledgeDb(root);
  const codeDb = openCodeDb(root);
  try {
    const name = root.split('/').filter(Boolean).pop() ?? root;
    const storedFp = getPipelineState(knowDb, 'config_model_fingerprint');
    const modelDrift = Boolean(storedFp) && storedFp !== configModelFingerprint(loadConfig(root));
    const unclusteredFacts = (knowDb.prepare(`SELECT COUNT(*) AS n FROM k_nodes WHERE cluster_id IS NULL`).get() as { n: number }).n;
    const conceptsMissingSummary = (knowDb.prepare(
      `SELECT COUNT(*) AS n FROM concepts WHERE (summary IS NULL OR TRIM(summary)='') AND member_count > 0`,
    ).get() as { n: number }).n;
    const since = Date.now() - 24 * 3_600_000;
    const runs = knowDb.prepare(`SELECT ok, COUNT(*) AS n FROM agent_runs WHERE produced_at > ? GROUP BY ok`).all(since) as Array<{ ok: number; n: number }>;
    const recentFailures = runs.find((r) => r.ok === 0)?.n ?? 0;
    const recentRuns = runs.reduce((s, r) => s + r.n, 0);
    let pendingFiles = 0;
    try {
      pendingFiles = (codeDb.prepare(`
        SELECT COUNT(*) AS n FROM files f
        LEFT JOIN file_analysis a ON a.path = f.path AND a.content_hash = f.content_hash
        WHERE a.path IS NULL
      `).get() as { n: number }).n;
    } catch { /* file_analysis may be absent */ }
    return { path: root, name, unclusteredFacts, conceptsMissingSummary, pendingFiles, recentFailures, recentRuns, modelDrift };
  } finally {
    knowDb.close();
    codeDb.close();
  }
}

export interface FixResult {
  perProject: Array<{ path: string; attempted: number; summarized: number }>;
  globalWarnings: string[];
  globalDashboardPath?: string;
}

/** Repair missing summaries, re-link every project, rebuild dashboards. */
export async function runDoctorFixes(path?: string): Promise<FixResult> {
  const projects = resolveTargetProjects(path).filter((p) => existsSync(projectConfigDir(p)));
  const perProject: FixResult['perProject'] = [];
  for (const root of projects) {
    const cfg = loadConfig(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const r = await repairConceptSummaries(knowDb, cfg);
      perProject.push({ path: root, attempted: r.attempted, summarized: r.summarized });
    } finally {
      knowDb.close();
    }
  }
  const global = await runGlobalPipeline({
    projects,
    linkAllProjects: true,
    globalDashboard: true,
    projectDashboard: true,
  });
  return { perProject, globalWarnings: global.warnings, globalDashboardPath: global.globalDashboardPath };
}
