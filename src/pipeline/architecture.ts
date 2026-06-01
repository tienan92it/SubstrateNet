/**
 * Architecture pass: reconcile per-file layers into a coherent per-directory
 * architecture, then backfill files left as "other". Confident per-file layers
 * are preserved; only "other" files inherit their directory's canonical layer.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import { ARCHITECTURE_ANALYZER_AGENT, type ArchDirInput } from '../agents/architecture-analyzer.js';
import type { CodeGpsConfig } from '../config.js';

export interface ArchitectureStats {
  directories: number;
  filesReassigned: number;
}

const MAX_DIRS = 300;

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export async function runArchitecturePass(
  codeDb: SqliteDb,
  knowDb: SqliteDb,
  cfg: CodeGpsConfig,
): Promise<ArchitectureStats> {
  const stats: ArchitectureStats = { directories: 0, filesReassigned: 0 };

  const rows = codeDb.prepare(`SELECT path, layer FROM file_analysis WHERE layer IS NOT NULL`)
    .all() as Array<{ path: string; layer: string }>;
  if (rows.length === 0) return stats;

  // Histogram per directory.
  const byDir = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const d = dirOf(r.path);
    const h = byDir.get(d) ?? {};
    h[r.layer] = (h[r.layer] ?? 0) + 1;
    byDir.set(d, h);
  }

  // Cap to the largest directories to bound the prompt.
  const directories: ArchDirInput[] = [...byDir.entries()]
    .map(([path, histogram]) => ({ path, histogram }))
    .sort((a, b) => sum(b.histogram) - sum(a.histogram))
    .slice(0, MAX_DIRS);
  stats.directories = directories.length;

  let canonical: Map<string, string>;
  try {
    const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
    const out = await rt.run(ARCHITECTURE_ANALYZER_AGENT, { payload: { directories } });
    canonical = new Map(out.output.directories.map((d) => [d.path, d.layer]));
  } catch {
    // Fallback: deterministic majority vote per directory.
    canonical = new Map(directories.map((d) => [d.path, dominant(d.histogram)]));
  }

  const update = codeDb.prepare(`UPDATE file_analysis SET layer=? WHERE path=? AND layer='other'`);
  const tx = codeDb.transaction(() => {
    for (const r of rows) {
      if (r.layer !== 'other') continue;
      const layer = canonical.get(dirOf(r.path));
      if (layer && layer !== 'other') {
        update.run(layer, r.path);
        stats.filesReassigned++;
      }
    }
  });
  tx();
  return stats;
}

function sum(h: Record<string, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}

function dominant(h: Record<string, number>): string {
  let best = 'other';
  let n = -1;
  for (const [k, v] of Object.entries(h)) {
    if (k !== 'other' && v > n) { best = k; n = v; }
  }
  return best;
}
