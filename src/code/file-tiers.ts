/**
 * File analyze tiers — skip tests/generated, prioritize entrypoints / fan-in.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { AnalyzeConfig, AnalyzeTierProfile } from '../config.js';
import { resolveAnalyzeConfig } from '../config.js';
import type { SubstrateNetConfig } from '../config.js';

export type FileTier = 0 | 1 | 2;

const SKIP_RE = [
  /\/__tests__\//,
  /\/__mocks__\//,
  /\/fixtures?\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.generated\./,
  /\/vendor\//,
];

const ENTRY_RE = /(^|\/)(index|main|app|server|cli)\.[cm]?[jt]sx?$/;

export function fileTier(path: string, skipGlobs: string[] = []): FileTier {
  const norm = path.replace(/\\/g, '/');
  for (const re of SKIP_RE) {
    if (re.test(norm)) return 0;
  }
  for (const g of skipGlobs) {
    if (g && norm.includes(g.replace(/\*\*/g, '').replace(/\*/g, ''))) return 0;
  }
  if (ENTRY_RE.test(norm)) return 1;
  return 2;
}

/** Rank files by inbound call edges (proxy for architectural importance). */
export function fanInScores(codeDb: SqliteDb): Map<string, number> {
  const rows = codeDb.prepare(`
    SELECT s.file_path AS path, COUNT(*) AS n
    FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND t.file_path IS NOT NULL
    GROUP BY s.file_path
  `).all() as Array<{ path: string; n: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.path, r.n);
  return m;
}

export function assignFileTiers(
  paths: string[],
  codeDb: SqliteDb,
  cfg: AnalyzeConfig,
): Map<string, FileTier> {
  const skipGlobs = cfg.skipGlobs ?? [];
  const fanIn = fanInScores(codeDb);
  const scored = paths
    .map((p) => ({ p, tier: fileTier(p, skipGlobs), fan: fanIn.get(p) ?? 0 }))
    .filter((x) => x.tier !== 0);

  const fans = scored.map((s) => s.fan).sort((a, b) => b - a);
  const cutoff = fans[Math.floor(fans.length * 0.15)] ?? 1;

  const out = new Map<string, FileTier>();
  for (const p of paths) {
    const base = fileTier(p, skipGlobs);
    if (base === 0) {
      out.set(p, 0);
      continue;
    }
    const fan = fanIn.get(p) ?? 0;
    out.set(p, base === 1 || fan >= cutoff ? 1 : 2);
  }
  return out;
}

export function filterPathsForAnalyze(
  paths: string[],
  codeDb: SqliteDb,
  cfg: SubstrateNetConfig,
  profile: AnalyzeTierProfile,
): { analyze: string[]; skipped: number } {
  if (profile === 'lean') return { analyze: [], skipped: paths.length };
  if (profile === 'deep') {
    const max = resolveAnalyzeConfig(cfg).maxFilesPerRun ?? 500;
    return { analyze: paths.slice(0, max), skipped: Math.max(0, paths.length - max) };
  }

  const analyzeCfg = resolveAnalyzeConfig(cfg);
  const tiers = assignFileTiers(paths, codeDb, analyzeCfg);
  const tier1 = paths.filter((p) => tiers.get(p) === 1);
  const max = analyzeCfg.maxFilesPerRun ?? 500;
  const analyze = tier1.slice(0, max);
  return { analyze, skipped: paths.length - analyze.length };
}
