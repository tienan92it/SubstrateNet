/**
 * Cluster pipeline.
 *
 * For each newly-created (or updated) L2 fact:
 *   1. Compute candidate concepts via embedding proximity (top-K).
 *   2. Decide attach / create / merge:
 *        - score >= AUTO_ATTACH_SCORE      -> mechanical attach (no LLM)
 *        - no candidates                    -> mechanical create (no LLM)
 *        - otherwise (the ambiguous band)   -> Clusterer Agent decides
 *   3. Apply the decision: write cluster_id, possibly merge two concepts.
 *   4. Mark affected concepts dirty.
 *
 * Facts are processed in waves of `concurrency`: the (parallel) LLM decisions
 * for a wave resolve first, then writes apply sequentially. This removes the
 * old per-fact serial LLM dependency while keeping DB writes single-threaded.
 *
 * After clustering, each dirty concept is re-centroided and (re-)summarized.
 * Stable small concepts that already have a summary are skipped.
 *
 * Idempotent: facts already assigned to a cluster are skipped unless
 * `opts.reCluster` is true.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import { CLUSTERER_AGENT, type ClustererAction } from '../agents/clusterer.js';
import { CLUSTERER_BATCH_AGENT } from '../agents/clusterer-batch.js';
import { SUMMARIZER_AGENT } from '../agents/summarizer.js';
import { resolveIngestConfig } from '../config.js';
import { DedupeAgent, getKNodeEmbedding } from '../agents/dedupe.js';
import { upsertConcept, newConceptId, setKNodeCluster, membersOf, nearestConcepts, recountAndCentroid, encodeCentroid } from '../knowledge/concept-store.js';
import { scopeFromDomain, dominantGrounding, dominantScope } from '../knowledge/scope.js';
import { mapPool } from '../util/pool.js';
import type { SubstrateNetConfig } from '../config.js';

/**
 * Leaf/evidence kinds are NOT clustered into concepts — they are citations,
 * not ideas. Keeps L3 concepts meaningful (decisions, rules, skills, ...).
 */
/** Leaf/evidence kinds excluded from L3 clustering — shared with setup planner. */
export const CLUSTER_EVIDENCE_KINDS = [
  'path_mention', 'code_block', 'shell_command', 'error_message',
  'stack_trace', 'ticket_id', 'url', 'dependency', 'tool', 'knowledge_gap',
  // Organizational zone nodes are taxonomy, not clusterable ideas.
  'business_domain', 'tech_domain',
  // Structured RCA records are linked by edges, not clustered into concepts.
  'incident', 'root_cause',
] as const;

const EVIDENCE_KINDS: readonly string[] = CLUSTER_EVIDENCE_KINDS;

/** Candidate pool size + the minimum similarity to even consider a concept. */
const CANDIDATE_K = 5;
const CANDIDATE_MIN_SCORE = 0.60;
/** Top candidate at/above this similarity attaches mechanically (skip the LLM). */
const AUTO_ATTACH_SCORE = 0.88;
/** At apply time, re-check for a near-duplicate before creating a new concept. */
const REFRESH_ATTACH_SCORE = 0.85;
/** Stable concepts with <= this many members + an existing summary skip re-summarize. */
const STABLE_MEMBER_MAX = 3;

export interface ClusterStats {
  processed: number;
  attached: number;
  created: number;
  merged: number;
  /** Facts attached/created mechanically (no LLM call). */
  mechanical: number;
  /** LLM cluster decisions (single + batch calls). */
  llmDecisions: number;
  conceptsSummarized: number;
}

export interface ClusterOpts {
  reCluster?: boolean;
}

type FactRow = { id: string; kind: string; title: string; summary: string | null };

/** A clustering decision for one fact, resolved (possibly via LLM) before writes. */
type FactDecision = {
  fact: FactRow;
  embedding?: Float32Array;
  candidates: Array<{ id: string; name: string; summary?: string; score: number }>;
  action: ClustererAction;
  /** Whether the action was decided without an LLM call. */
  mechanical: boolean;
};

type AmbiguousFact = {
  fact: FactRow;
  embedding: Float32Array;
  candidates: Array<{ id: string; name: string; summary?: string; score: number }>;
};

export async function runClustererForNewFacts(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, opts: ClusterOpts = {},
): Promise<ClusterStats> {
  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });

  const exclusion = `kind NOT IN (${EVIDENCE_KINDS.map(() => '?').join(',')})`;
  const where = opts.reCluster ? `WHERE ${exclusion}` : `WHERE cluster_id IS NULL AND ${exclusion}`;
  const facts = knowDb.prepare(`
    SELECT id, kind, title, summary FROM k_nodes ${where}
    ORDER BY created_at ASC
  `).all(...EVIDENCE_KINDS) as FactRow[];

  const stats: ClusterStats = {
    processed: 0, attached: 0, created: 0, merged: 0, mechanical: 0, llmDecisions: 0, conceptsSummarized: 0,
  };
  const dirty = new Set<string>();
  const limit = Math.max(1, cfg.concurrency ?? 4);
  const batchSize = Math.max(1, cfg.batchSize ?? 8);
  const useBatch = resolveIngestConfig(cfg).clusterBatch !== false;

  // Process in waves: mechanical decisions first, batch LLM for ambiguous band,
  // then apply (sequential writes). Candidates are read at wave start, so a
  // refresh re-check at apply time absorbs intra-wave near-duplicates.
  for (let i = 0; i < facts.length; i += limit) {
    const wave = facts.slice(i, i + limit);
    const decisions = await decideWave(rt, knowDb, wave, batchSize, useBatch, stats);
    for (const d of decisions) {
      stats.processed++;
      if (d.mechanical) stats.mechanical++;
      const touched = applyDecision(knowDb, d, stats);
      if (touched) dirty.add(touched);
    }
  }

  stats.conceptsSummarized = await recomputeAndSummarize(rt, knowDb, [...dirty], limit, { skipStable: true });
  return stats;
}

async function decideWave(
  rt: AgentRuntime,
  knowDb: SqliteDb,
  wave: FactRow[],
  batchSize: number,
  useBatch: boolean,
  stats: ClusterStats,
): Promise<FactDecision[]> {
  const mechanical: FactDecision[] = [];
  const ambiguous: AmbiguousFact[] = [];

  for (const fact of wave) {
    const partial = decideFactMechanical(knowDb, fact);
    if ('mechanical' in partial) mechanical.push(partial);
    else ambiguous.push(partial);
  }

  const llm = await decideAmbiguousFacts(rt, ambiguous, batchSize, useBatch, stats);
  return [...mechanical, ...llm];
}

/** Mechanical path: clear attach/create/no-embedding. Returns ambiguous facts without action. */
function decideFactMechanical(knowDb: SqliteDb, fact: FactRow): FactDecision | AmbiguousFact {
  const v = getKNodeEmbedding(knowDb, fact.id) ?? undefined;
  if (!v) {
    return {
      fact, candidates: [],
      action: { action: 'create', suggestedName: '', confidence: 0, reason: 'no-embedding' },
      mechanical: true,
    };
  }

  const candidates = nearestConcepts(knowDb, v, CANDIDATE_K, CANDIDATE_MIN_SCORE);

  if (candidates.length > 0 && candidates[0].score >= AUTO_ATTACH_SCORE) {
    return {
      fact, embedding: v, candidates,
      action: { action: 'attach', conceptId: candidates[0].id, confidence: candidates[0].score, reason: 'mechanical-attach' },
      mechanical: true,
    };
  }

  if (candidates.length === 0) {
    return {
      fact, embedding: v, candidates,
      action: { action: 'create', suggestedName: fact.title.slice(0, 60), confidence: 0.4, reason: 'mechanical-create' },
      mechanical: true,
    };
  }

  return { fact, embedding: v, candidates };
}

async function decideAmbiguousFacts(
  rt: AgentRuntime,
  items: AmbiguousFact[],
  batchSize: number,
  useBatch: boolean,
  stats: ClusterStats,
): Promise<FactDecision[]> {
  if (items.length === 0) return [];

  const out: FactDecision[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    if (useBatch && batch.length > 1) {
      const batchDecisions = await decideFactBatch(rt, batch, stats);
      out.push(...batchDecisions);
    } else {
      for (const item of batch) {
        out.push(await decideFactSingle(rt, item, stats));
      }
    }
  }
  return out;
}

/** Batch LLM for the ambiguous band; falls back to per-fact clusterer on parse failure. */
async function decideFactBatch(
  rt: AgentRuntime,
  batch: AmbiguousFact[],
  stats: ClusterStats,
): Promise<FactDecision[]> {
  const payload = {
    items: batch.map((b) => ({
      factId: b.fact.id,
      fact: { kind: b.fact.kind, title: b.fact.title, summary: b.fact.summary ?? undefined },
      candidates: b.candidates.map(({ id, name, summary }) => ({ id, name, summary })),
    })),
  };

  try {
    const out = await rt.run(CLUSTERER_BATCH_AGENT, { payload });
    stats.llmDecisions += 1;
    const byId = new Map(out.output.results.map((r) => [r.factId, r]));
    const decisions: FactDecision[] = [];
    const retry: AmbiguousFact[] = [];

    for (const item of batch) {
      const row = byId.get(item.fact.id);
      if (row) {
        const action: ClustererAction = row.action === 'attach'
          ? { action: 'attach', conceptId: row.conceptId, confidence: row.confidence, reason: row.reason }
          : row.action === 'merge'
            ? { action: 'merge', conceptIds: row.conceptIds, suggestedName: row.suggestedName, confidence: row.confidence, reason: row.reason }
            : { action: 'create', suggestedName: row.suggestedName, confidence: row.confidence, reason: row.reason };
        decisions.push({ ...item, action, mechanical: false });
      } else {
        retry.push(item);
      }
    }

    if (decisions.length >= Math.ceil(batch.length / 2)) {
      for (const item of retry) {
        decisions.push(await decideFactSingle(rt, item, stats));
      }
      return decisions;
    }
  } catch { /* fall through to singles */ }

  const decisions: FactDecision[] = [];
  for (const item of batch) {
    decisions.push(await decideFactSingle(rt, item, stats));
  }
  return decisions;
}

async function decideFactSingle(
  rt: AgentRuntime,
  item: AmbiguousFact,
  stats: ClusterStats,
): Promise<FactDecision> {
  try {
    const out = await rt.run(CLUSTERER_AGENT, {
      payload: {
        fact: { id: item.fact.id, kind: item.fact.kind, title: item.fact.title, summary: item.fact.summary ?? undefined },
        candidates: item.candidates,
      },
    });
    stats.llmDecisions += 1;
    return { ...item, action: out.output, mechanical: false };
  } catch {
    return {
      ...item,
      action: { action: 'create', suggestedName: item.fact.title.slice(0, 60), confidence: 0.3, reason: 'fallback' },
      mechanical: false,
    };
  }
}

/** Apply a resolved decision. Returns the touched concept id (added to dirty). */
function applyDecision(knowDb: SqliteDb, d: FactDecision, stats: ClusterStats): string | undefined {
  const { fact, embedding, candidates, action } = d;

  // No-embedding fact: per-kind uncategorized bucket.
  if (!embedding) {
    const fallbackName = `${fact.kind} (uncategorized)`;
    const existing = knowDb.prepare(`SELECT id FROM concepts WHERE name=?`).get(fallbackName) as { id: string } | undefined;
    const cid = existing?.id ?? newConceptId(fallbackName);
    if (!existing) {
      upsertConcept(knowDb, { id: cid, name: fallbackName, summary: undefined, memberCount: 0 });
      stats.created++;
    }
    setKNodeCluster(knowDb, fact.id, cid);
    stats.attached++;
    refreshCentroid(knowDb, cid);
    return cid;
  }

  let touched: string | undefined;

  if (action.action === 'attach') {
    // Mechanical attaches reference the live top candidate; LLM attaches must
    // reference a candidate we offered.
    const ok = candidates.find((c) => c.id === action.conceptId);
    if (ok) {
      setKNodeCluster(knowDb, fact.id, action.conceptId);
      touched = action.conceptId;
      stats.attached++;
    }
  } else if (action.action === 'merge') {
    const [a, b] = action.conceptIds;
    const validA = candidates.find((c) => c.id === a);
    const validB = candidates.find((c) => c.id === b);
    if (validA && validB) {
      knowDb.transaction(() => {
        knowDb.prepare(`UPDATE k_nodes SET cluster_id=? WHERE cluster_id=?`).run(a, b);
        knowDb.prepare(`DELETE FROM concepts WHERE id=?`).run(b);
        knowDb.prepare(`UPDATE concepts SET name=? WHERE id=?`).run(action.suggestedName, a);
      })();
      setKNodeCluster(knowDb, fact.id, a);
      touched = a;
      stats.attached++;
      stats.merged++;
    }
  }

  if (!touched) {
    // create (also acts as fallback when attach/merge couldn't be applied).
    // Refresh re-check: a concept created earlier in this wave may now be a
    // strong match, so attach instead of creating a duplicate.
    const refreshed = nearestConcepts(knowDb, embedding, 1, REFRESH_ATTACH_SCORE);
    if (refreshed.length > 0) {
      setKNodeCluster(knowDb, fact.id, refreshed[0].id);
      touched = refreshed[0].id;
      stats.attached++;
    } else {
      const suggestedName = action.action === 'create' && action.suggestedName
        ? action.suggestedName
        : fact.title.slice(0, 60);
      const cid = newConceptId(suggestedName);
      upsertConcept(knowDb, { id: cid, name: suggestedName, memberCount: 0 });
      setKNodeCluster(knowDb, fact.id, cid);
      touched = cid;
      stats.created++;
      stats.attached++;
    }
  }

  refreshCentroid(knowDb, touched);
  return touched;
}

/** Recompute member_count + centroid for one concept. */
function refreshCentroid(knowDb: SqliteDb, conceptId: string): void {
  const { memberCount, centroid } = recountAndCentroid(knowDb, conceptId);
  knowDb.prepare(`UPDATE concepts SET member_count=?, embedding=? WHERE id=?`)
    .run(memberCount, centroid ? encodeCentroid(centroid) : null, conceptId);
}

/**
 * Re-centroid + (re-)summarize the given concepts. Summarizer calls run
 * concurrently; DB writes apply sequentially. Returns count actually summarized.
 *
 * Concepts with no members get their stale member_count zeroed and are skipped.
 * When `skipStable`, small concepts that already have a summary are left as-is.
 */
async function recomputeAndSummarize(
  rt: AgentRuntime, knowDb: SqliteDb, ids: string[], limit: number, opts: { skipStable: boolean },
): Promise<number> {
  const summarized = await mapPool(ids, limit, async (cid) => {
    const members = membersOf(knowDb, cid).slice(0, 25);
    const currentRow = knowDb.prepare(`SELECT name, summary, domain, structured FROM concepts WHERE id=?`).get(cid) as
      { name: string; summary: string | null; domain: string | null; structured: string | null } | undefined;

    if (members.length === 0) {
      // Orphaned concept (e.g. after a merge): clear stale count, skip summarize.
      knowDb.prepare(`UPDATE concepts SET member_count=0 WHERE id=?`).run(cid);
      return { cid, skip: true as const };
    }

    let name = currentRow?.name ?? '';
    let summary = currentRow?.summary ?? undefined;
    let domain = currentRow?.domain ?? undefined;
    let structured = currentRow?.structured ? JSON.parse(currentRow.structured) as Record<string, string> : undefined;

    const stable = Boolean(currentRow?.summary && currentRow.summary.trim()) && members.length <= STABLE_MEMBER_MAX;
    if (opts.skipStable && stable) {
      return { cid, name, summary, domain, structured, didSummarize: false };
    }

    try {
      const out = await rt.run(SUMMARIZER_AGENT, {
        payload: {
          conceptId: cid,
          currentName: name,
          facts: members.map((m) => ({ kind: m.kind, title: m.title, summary: m.summary ?? undefined })),
        },
      });
      name = out.output.name || name;
      summary = out.output.summary;
      domain = out.output.domain;
      structured = pruneStructured(out.output.structured);
      return { cid, name, summary, domain, structured, didSummarize: true };
    } catch {
      return { cid, name, summary, domain, structured, didSummarize: false };
    }
  });

  let count = 0;
  for (const s of summarized) {
    if ('skip' in s) continue;
    const cid = s.cid;
    const { memberCount, centroid } = recountAndCentroid(knowDb, cid);
    if (s.didSummarize) count++;

    const memberMeta = knowDb.prepare(
      `SELECT grounding, scope FROM k_nodes WHERE cluster_id=?`,
    ).all(cid) as Array<{ grounding: string | null; scope: string | null }>;
    const scope = dominantScope(memberMeta.map((m) => m.scope)) ?? scopeFromDomain(s.domain);
    const grounding = dominantGrounding(memberMeta.map((m) => m.grounding));

    knowDb.prepare(`
      UPDATE concepts SET name=?, summary=?, domain=?, scope=?, grounding=?, structured=?, member_count=?, embedding=? WHERE id=?
    `).run(
      s.name, s.summary ?? null, s.domain ?? null, scope, grounding,
      s.structured ? JSON.stringify(s.structured) : null,
      memberCount, centroid ? encodeCentroid(centroid) : null, cid,
    );
  }
  return count;
}

/**
 * Re-summarize concepts that still lack a summary (e.g. after a failed or
 * interrupted summarizer pass). Used by `subnet doctor --fix`.
 */
export async function repairConceptSummaries(
  knowDb: SqliteDb, cfg: SubstrateNetConfig,
): Promise<{ attempted: number; summarized: number }> {
  const rows = knowDb.prepare(`
    SELECT id FROM concepts
    WHERE (summary IS NULL OR TRIM(summary) = '') AND member_count > 0
  `).all() as Array<{ id: string }>;
  if (rows.length === 0) return { attempted: 0, summarized: 0 };

  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const limit = Math.max(1, cfg.concurrency ?? 4);
  const summarized = await recomputeAndSummarize(rt, knowDb, rows.map((r) => r.id), limit, { skipStable: false });
  return { attempted: rows.length, summarized };
}

/** Keep only non-empty structured fields; return undefined if all empty. */
function pruneStructured(s: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}
