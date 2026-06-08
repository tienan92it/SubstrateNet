/**
 * Shared per-project pipeline runner.
 *
 * Single entry point used by `subnet setup`, `subnet update`, and `subnet watch`
 * so the stage sequence (init -> sync -> ingest -> verify) and the
 * speed/quality profiles stay consistent across commands.
 *
 * Profiles:
 *   - fast:    transcript-only delta. Skips analyze + enrich (no heavy agents).
 *   - default: incremental. Runs analyze + enrich; their internal hashing skips
 *              unchanged inputs.
 *   - full:    reprocess every window (e.g. after a model swap).
 */
import { resolve, basename } from 'path';
import { loadConfig } from '../config.js';
import { syncProject } from '../code/sync.js';
import { ingestProject } from '../ingest/orchestrator.js';
import { runVerify } from './verify.js';
import { openKnowledgeDb } from '../db/connection.js';
import { ensureProjectInitialized } from '../setup/init-project.js';
import type { SetupProgressFn } from '../setup/types.js';
import type { AgentId } from '../types.js';

export type RunProfile = 'full' | 'default' | 'fast';

export interface RunProjectOpts {
  profile: RunProfile;
  /** Restrict ingest to one transcript adapter. */
  agentFilter?: AgentId;
  /** Run the verifier pass after ingest. */
  verify?: boolean;
  /** Force a full code re-index (only meaningful with profile=full). */
  syncFull?: boolean;
  onProgress?: SetupProgressFn;
}

export interface RunProjectResult {
  path: string;
  name: string;
  ok: boolean;
  error?: string;
  /** stage name -> wall-clock ms. */
  stages: Record<string, number>;
  durationMs: number;
  /** Agent runs recorded during this pipeline run. */
  runs: number;
  /** Failed agent runs during this pipeline run. */
  failures: number;
}

export async function runProjectPipeline(root: string, opts: RunProjectOpts): Promise<RunProjectResult> {
  const abs = resolve(root);
  const name = basename(abs);
  const stages: Record<string, number> = {};
  const t0 = Date.now();
  const result: RunProjectResult = { path: abs, name, ok: false, stages, durationMs: 0, runs: 0, failures: 0 };
  const emit = (stage: string) => opts.onProgress?.({ kind: 'stage', project: name, stage });

  const fast = opts.profile === 'fast';
  const full = opts.profile === 'full';

  try {
    emit('init');
    ensureProjectInitialized(abs);

    emit('sync');
    let ts = Date.now();
    await syncProject(abs, { full: full && opts.syncFull });
    stages.sync = Date.now() - ts;

    emit('ingest');
    ts = Date.now();
    await ingestProject(abs, {
      agentFilter: opts.agentFilter,
      reprocess: full,
      runAnalyze: !fast,
      runEnrich: !fast,
      onProgress: (p) => opts.onProgress?.({
        kind: 'progress', project: name, stage: p.stage,
        current: p.current ?? 0, total: p.total ?? 0, detail: p.detail,
      }),
    });
    stages.ingest = Date.now() - ts;

    if (opts.verify) {
      emit('verify');
      ts = Date.now();
      const cfg = loadConfig(abs);
      const db = openKnowledgeDb(abs);
      try {
        await runVerify(db, cfg, { pruneBelowConfidence: 0.25, maxPairsPerCluster: 5 });
      } finally {
        db.close();
      }
      stages.verify = Date.now() - ts;
    }

    result.ok = true;
    opts.onProgress?.({ kind: 'projectDone', project: name, ok: true });
  } catch (e) {
    result.error = (e as Error).message;
    opts.onProgress?.({ kind: 'projectDone', project: name, ok: false, error: result.error });
  }

  // Count agent runs recorded during this pipeline so callers can gate on the
  // failure rate (a run that "completes" but fails most LLM calls is suspect).
  try {
    const db = openKnowledgeDb(abs);
    try {
      const rows = db.prepare(`SELECT ok, COUNT(*) AS n FROM agent_runs WHERE produced_at >= ? GROUP BY ok`).all(t0) as Array<{ ok: number; n: number }>;
      result.runs = rows.reduce((s, r) => s + r.n, 0);
      result.failures = rows.find((r) => r.ok === 0)?.n ?? 0;
    } finally {
      db.close();
    }
  } catch { /* non-fatal */ }

  result.durationMs = Date.now() - t0;
  return result;
}
