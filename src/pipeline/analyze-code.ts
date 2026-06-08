/**
 * Code-grounded analysis pipeline (tree-sitter -> LLM, the hybrid's semantic half).
 *
 * For each indexed file it builds a deterministic payload from code.db — the
 * file's definitions, resolved imports, and call-sites — plus a bounded source
 * slice, then runs the FileAnalyzer agent to produce a summary, architectural
 * layer, tags, and language concepts. Results land in code.db `file_analysis`.
 *
 * Incremental: a file whose `files.content_hash` matches its stored
 * `file_analysis.content_hash` is skipped unless `full` is set. LLM calls run
 * with bounded concurrency.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AgentRuntime } from '../agents/runtime.js';
import { FILE_ANALYZER_AGENT, type FileAnalyzerPayload } from '../agents/file-analyzer.js';
import '../agents/index.js';
import type { SubstrateNetConfig } from '../config.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { mapPool } from '../util/pool.js';
import { runArchitecturePass } from './architecture.js';
import { filterPathsForAnalyze } from '../code/file-tiers.js';
import type { AnalyzeTierProfile } from '../config.js';
import { bumpPipelineAudit } from '../knowledge/pipeline-audit.js';

export interface AnalyzeStats {
  filesAnalyzed: number;
  filesSkipped: number;
  failed: number;
  byLayer: Record<string, number>;
  layersReassigned: number;
}

const MAX_SOURCE_CHARS = 3000;

interface FileRow { path: string; content_hash: string; language: string; }

/** Build the deterministic analyzer payload for one file from code.db + disk. */
function buildPayload(codeDb: SqliteDb, root: string, f: FileRow): FileAnalyzerPayload {
  const defs = (codeDb.prepare(`
    SELECT name, kind, signature FROM nodes
    WHERE file_path=? AND kind IN ('function','method','class','module','field')
    ORDER BY start_line LIMIT 80
  `).all(f.path) as Array<{ name: string; kind: string; signature: string | null }>)
    .map((d) => ({ name: d.name, kind: d.kind, signature: d.signature ?? undefined }));

  const imports = (codeDb.prepare(`
    SELECT name FROM nodes WHERE file_path=? AND kind='import' ORDER BY start_line LIMIT 80
  `).all(f.path) as Array<{ name: string }>).map((r) => r.name);

  // Resolved call targets out of this file's symbols, plus still-unresolved names.
  const resolvedCalls = (codeDb.prepare(`
    SELECT DISTINCT t.name AS name FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
    WHERE e.kind='calls' AND s.file_path=? LIMIT 80
  `).all(f.path) as Array<{ name: string }>).map((r) => r.name);
  const unresolvedCalls = (codeDb.prepare(`
    SELECT DISTINCT reference_name AS name FROM unresolved_refs WHERE file_path=? LIMIT 40
  `).all(f.path) as Array<{ name: string }>).map((r) => r.name);
  const calls = [...new Set([...resolvedCalls, ...unresolvedCalls])];

  let sourceSlice = '';
  try {
    sourceSlice = readFileSync(join(root, f.path), 'utf8').slice(0, MAX_SOURCE_CHARS);
  } catch { /* file may be gone; structure still carries signal */ }

  return { path: f.path, language: f.language, defs, imports, calls, sourceSlice };
}

export function upsertFileAnalysis(
  codeDb: SqliteDb,
  row: { path: string; summary: string; layer: string; tags: string[]; concepts: string[]; model: string; contentHash: string },
): void {
  codeDb.prepare(`
    INSERT INTO file_analysis (path, summary, layer, tags, language_concepts, model, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      summary=excluded.summary, layer=excluded.layer, tags=excluded.tags,
      language_concepts=excluded.language_concepts, model=excluded.model,
      content_hash=excluded.content_hash, updated_at=excluded.updated_at
  `).run(
    row.path, row.summary, row.layer,
    JSON.stringify(row.tags), JSON.stringify(row.concepts),
    row.model, row.contentHash, Date.now(),
  );
}

export interface AnalyzeOpts {
  full?: boolean;
  analyzeProfile?: AnalyzeTierProfile;
  onFile?: (current: number, total: number) => void;
}

/** Open code.db + knowledge.db (the latter hosts the agent_runs cache) and analyze. */
export async function analyzeProject(
  root: string,
  cfg: SubstrateNetConfig,
  opts: AnalyzeOpts = {},
): Promise<AnalyzeStats> {
  const codeDb = openCodeDb(root);
  const knowDb = openKnowledgeDb(root);
  try {
    return await analyzeWithDbs(codeDb, knowDb, root, cfg, opts);
  } finally {
    codeDb.close();
    knowDb.close();
  }
}

/** Analyze using already-open DB handles (used by the ingest pipeline). */
export async function analyzeWithDbs(
  codeDb: SqliteDb,
  knowDb: SqliteDb,
  root: string,
  cfg: SubstrateNetConfig,
  opts: AnalyzeOpts = {},
): Promise<AnalyzeStats> {
  const stats: AnalyzeStats = { filesAnalyzed: 0, filesSkipped: 0, failed: 0, byLayer: {}, layersReassigned: 0 };
  {
    const files = codeDb.prepare(`SELECT path, content_hash, language FROM files`).all() as FileRow[];

    // Determine which files need (re)analysis.
    const prior = new Map<string, string>();
    for (const r of codeDb.prepare(`SELECT path, content_hash FROM file_analysis`).all() as Array<{ path: string; content_hash: string }>) {
      prior.set(r.path, r.content_hash);
    }
    let pending = files.filter((f) => opts.full || prior.get(f.path) !== f.content_hash);
    const profile: AnalyzeTierProfile = opts.full ? 'deep' : (opts.analyzeProfile ?? 'standard');
    const { analyze, skipped } = filterPathsForAnalyze(
      pending.map((f) => f.path), codeDb, cfg, profile,
    );
    const analyzeSet = new Set(analyze);
    pending = pending.filter((f) => analyzeSet.has(f.path));
    stats.filesSkipped = files.length - pending.length;
    if (skipped > 0) bumpPipelineAudit(knowDb, { filesAnalyzeSkippedTier: skipped });

    const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
    const limit = cfg.concurrency ?? 4;

    let fileDone = 0;
    const outcomes = await mapPool(pending, limit, async (f) => {
      try {
        const payload = buildPayload(codeDb, root, f);
        const out = await rt.run(FILE_ANALYZER_AGENT, { payload });
        fileDone++;
        opts.onFile?.(fileDone, pending.length);
        return { f, out };
      } catch {
        fileDone++;
        opts.onFile?.(fileDone, pending.length);
        return undefined;
      }
    });

    for (const oc of outcomes) {
      if (!oc) { stats.failed++; continue; }
      const { f, out } = oc;
      upsertFileAnalysis(codeDb, {
        path: f.path,
        summary: out.output.summary,
        layer: out.output.layer,
        tags: out.output.tags,
        concepts: out.output.concepts,
        model: out.model,
        contentHash: f.content_hash,
      });
      stats.filesAnalyzed++;
      stats.byLayer[out.output.layer] = (stats.byLayer[out.output.layer] ?? 0) + 1;
    }

    // Reconcile per-file layers into a coherent per-directory architecture.
    if (stats.filesAnalyzed > 0 || opts.full) {
      try {
        const arch = await runArchitecturePass(codeDb, knowDb, cfg);
        stats.layersReassigned = arch.filesReassigned;
      } catch { /* best-effort */ }
    }
  }
  return stats;
}
