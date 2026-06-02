/**
 * Ingest orchestrator.
 *
 *   1. Discover sessions from configured adapters.
 *   2. Read new turns (incremental via sessions.ingest_offset).
 *   3. Re-segment session into windows; insert new ones.
 *   4. Run deterministic syntax pass over each new window.
 *   5. (M3+) Triage Agent labels each new window.
 *   6. (M5+) Extractor agents on kept windows.
 *
 * This file owns 1–4 and stubs 5–6 (they get filled in by their milestones).
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { loadConfig } from '../config.js';
import { CursorAdapter } from './cursor.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { CopilotAdapter } from './copilot.js';
import type { SessionAdapter } from './base.js';
import { insertTurn, nextTurnIdx, turnsForSession, updateOffset, upsertSession } from './store.js';
import { insertWindow, segmentTurnsToWindows } from '../pipeline/segmenter.js';
import { runSyntaxPass } from '../pipeline/syntax.js';
import { upsertKNode, insertProvenance } from '../knowledge/store.js';
import { resolvePath, writeKToCode } from '../pipeline/resolve.js';
import type { AgentId, Turn } from '../types.js';
import { runTriageForWindows, type TriageRunResult } from '../pipeline/triage.js';
import { runExtractorsForKeptWindows } from '../pipeline/extract.js';
import { runClustererForNewFacts } from '../pipeline/cluster.js';
import { runEnrichment } from '../pipeline/enrich.js';
import { analyzeWithDbs } from '../pipeline/analyze-code.js';

export interface IngestProgress {
  stage: 'discover' | 'ingest' | 'segment' | 'triage' | 'extract' | 'cluster' | 'analyze' | 'enrich';
  current?: number;
  total?: number;
  detail?: string;
}

export interface IngestOpts {
  agentFilter?: AgentId;
  runTriage?: boolean;
  runExtract?: boolean;
  /** Skip the domain enrichment pass (L2.5). Defaults to running it. */
  runEnrich?: boolean;
  /** Skip the code-grounded analysis pass (file summaries + layers). Defaults to running it. */
  runAnalyze?: boolean;
  /**
   * Re-run triage/extract/cluster over ALL existing windows, not just newly
   * ingested ones. Use after switching models or to finish an interrupted run.
   */
  reprocess?: boolean;
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestStats {
  sessionsSeen: number;
  sessionsNew: number;
  turnsIngested: number;
  windowsCreated: number;
  triaged: number;
  kept: number;
  dropped: number;
  factsProduced: number;
  conceptsCreated: number;
  conceptsAttached: number;
  domainEntities: number;
  domainRelationships: number;
  knowledgeGaps: number;
  filesAnalyzed: number;
}

export async function ingestProject(root: string, opts: IngestOpts = {}): Promise<IngestStats> {
  const cfg = loadConfig(root);
  const codeDb = openCodeDb(root);
  const knowDb = openKnowledgeDb(root);

  const stats: IngestStats = {
    sessionsSeen: 0, sessionsNew: 0, turnsIngested: 0,
    windowsCreated: 0, triaged: 0, kept: 0, dropped: 0, factsProduced: 0,
    conceptsCreated: 0, conceptsAttached: 0,
    domainEntities: 0, domainRelationships: 0, knowledgeGaps: 0,
    filesAnalyzed: 0,
  };

  const progress = (p: IngestProgress) => opts.onProgress?.(p);

  try {
    const adapters: SessionAdapter[] = buildSessionAdapters(cfg, opts.agentFilter);
    const newWindowIds: string[] = [];

    progress({ stage: 'discover' });
    for (const adapter of adapters) {
      for await (const ref of adapter.discover(root)) {
        stats.sessionsSeen++;
        const now = Date.now();
        const { id: sessionId, isNew, offset } = upsertSession(knowDb, ref, now);
        if (isNew) stats.sessionsNew++;

        const firstNewIdx = nextTurnIdx(knowDb, sessionId);
        let lastOffset = offset;

        // Read new turns within a single transaction per session for speed.
        const insertTx = knowDb.transaction((batch: Array<{ idx: number; raw: any; offsetAfter: number }>) => {
          for (const item of batch) {
            insertTurn(knowDb, sessionId, item.idx, item.raw);
            stats.turnsIngested++;
            lastOffset = item.offsetAfter;
          }
          updateOffset(knowDb, sessionId, lastOffset);
        });

        const batch: Array<{ idx: number; raw: any; offsetAfter: number }> = [];
        let idx = firstNewIdx;
        for await (const { turn, offsetAfter } of adapter.read(ref, offset)) {
          batch.push({ idx, raw: turn, offsetAfter });
          idx++;
          if (batch.length >= 500) {
            insertTx(batch.splice(0, batch.length));
          }
        }
        if (batch.length) insertTx(batch);

        if (firstNewIdx === idx) continue; // nothing new

        // Re-segment from the first NEW turn — but we need context, so segment
        // from one user-turn earlier if possible.
        const segStart = Math.max(0, firstNewIdx - 4);
        const segTurns: Turn[] = turnsForSession(knowDb, sessionId, segStart);
        const windows = segmentTurnsToWindows(sessionId, segTurns);

        const newOnly = windows.filter((w) => parseInt(w.startTurn.split('-').pop()!, 10) >= firstNewIdx - 1);

        const windowTx = knowDb.transaction(() => {
          for (const w of newOnly) {
            const before = stats.windowsCreated;
            insertWindow(knowDb, w);
            // detect if it was new by checking if it had previously existed:
            const existed = knowDb
              .prepare(`SELECT 1 FROM turn_windows WHERE id=?`)
              .get(w.id);
            if (existed) {
              // count as created only if we didn't already process it (heuristic: no syntax facts yet)
              const haveSyntax = knowDb
                .prepare(`SELECT 1 FROM k_provenance WHERE window_id=? LIMIT 1`)
                .get(w.id);
              if (!haveSyntax) {
                runSyntaxForWindow(codeDb, knowDb, w.id, w.text);
                stats.windowsCreated++;
                newWindowIds.push(w.id);
              }
              if (stats.windowsCreated === before) {
                // window was already present + already had syntax pass; skip
              }
            }
          }
        });
        windowTx();
      }
    }

    // Which windows feed triage/extraction: only newly-created ones by default,
    // or EVERY existing window with --reprocess (e.g. after a model swap or an
    // interrupted run). Agent-run caching makes a same-model reprocess cheap;
    // a new model is a genuine re-run.
    const windowsToProcess = opts.reprocess
      ? (knowDb.prepare(`SELECT id FROM turn_windows ORDER BY rowid`).all() as Array<{ id: string }>).map((w) => w.id)
      : newWindowIds;

    // 5. Triage (M3)
    if (opts.runTriage !== false && windowsToProcess.length > 0) {
      progress({ stage: 'triage', current: 0, total: windowsToProcess.length });
      const tri: TriageRunResult = await runTriageForWindows(root, knowDb, cfg, windowsToProcess, {
        onWindow: (i, total) => progress({ stage: 'triage', current: i, total }),
      });
      stats.triaged = tri.triaged;
      stats.kept = tri.kept;
      stats.dropped = tri.dropped;
      // 6. Extractors only over kept windows (M5)
      if (opts.runExtract !== false && tri.keptWindowIds.length > 0) {
        progress({ stage: 'extract', current: 0, total: tri.keptWindowIds.length });
        const exStats = await runExtractorsForKeptWindows(root, knowDb, codeDb, cfg, tri.keptWindowIds, {
          onTask: (i, total) => progress({ stage: 'extract', current: i, total }),
        });
        stats.factsProduced = exStats.factsProduced;

        // 7. Clusterer + Summarizer over newly-produced facts (M7)
        if (exStats.factsProduced > 0) {
          const clStats = await runClustererForNewFacts(knowDb, cfg);
          stats.conceptsCreated = clStats.created;
          stats.conceptsAttached = clStats.attached;
        }
      }
    }

    // 7.5 Code-grounded analysis (file summaries + architectural layers).
    //     Depends on the L0 graph (from `sync`); incremental + idempotent.
    //     Runs before enrichment so the domain-analyzer can use layers.
    if (opts.runAnalyze !== false && opts.runExtract !== false) {
      try {
        const an = await analyzeWithDbs(codeDb, knowDb, root, cfg, {
          onFile: (i, total) => progress({ stage: 'analyze', current: i, total }),
        });
        stats.filesAnalyzed = an.filesAnalyzed;
      } catch { /* analysis is best-effort; pipeline continues */ }
    }

    // 8. Domain enrichment (L2.5). Runs unconditionally — structural
    //    extraction depends on the code graph (updated by `sync`, not ingest),
    //    and is idempotent. Skip only when explicitly disabled.
    if (opts.runEnrich !== false) {
      progress({ stage: 'enrich' });
      const enrich = await runEnrichment(root, knowDb, codeDb, cfg, { noAgent: opts.runExtract === false });
      stats.domainEntities = enrich.structuralEntities;
      stats.domainRelationships = enrich.structuralRelationships + enrich.agentRelationships;
      stats.knowledgeGaps = enrich.detectedGaps + enrich.agentGaps;
    }
  } finally {
    codeDb.close();
    knowDb.close();
  }
  return stats;
}

/** Build session adapters with configured transcript roots. */
export function buildSessionAdapters(cfg: ReturnType<typeof loadConfig>, filter?: AgentId): SessionAdapter[] {
  const roots = cfg.transcriptRoots;
  const all: SessionAdapter[] = [
    new CursorAdapter({ root: roots?.cursor }),
    new ClaudeCodeAdapter({ root: roots?.claudeCode }),
    new CodexAdapter({ root: roots?.codex }),
    new CopilotAdapter(),
  ];
  if (!filter) return all;
  return all.filter((a) => a.agent === filter);
}

function runSyntaxForWindow(codeDb: SqliteDb, knowDb: SqliteDb, windowId: string, text: string): number {
  const artifacts = runSyntaxPass(text, { windowId });
  let inserted = 0;
  const tx = knowDb.transaction(() => {
    for (const a of artifacts) {
      upsertKNode(knowDb, a.node);
      insertProvenance(knowDb, a.provenance);
      inserted++;
      if (a.pathMention) {
        const r = resolvePath(codeDb, a.pathMention);
        if (r) {
          writeKToCode(knowDb, {
            kNodeId: a.node.id,
            codeNodeId: r.codeNodeId,
            codeFile: r.codeFile,
            weight: 1,
          });
        }
      }
    }
  });
  tx();
  return inserted;
}
