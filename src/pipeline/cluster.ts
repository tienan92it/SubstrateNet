/**
 * Cluster pipeline.
 *
 * For each newly-created (or updated) L2 fact:
 *   1. Compute candidate concepts via embedding proximity (top-K).
 *   2. Call the Clusterer Agent to decide attach / create / merge.
 *   3. Apply the decision: write cluster_id, possibly merge two concepts.
 *   4. Mark affected concepts dirty.
 *
 * After all facts in a batch are clustered:
 *   5. For each dirty concept, recompute centroid + member_count,
 *      then call the Summarizer Agent to refresh its name/summary.
 *
 * Idempotent: facts already assigned to a cluster are skipped unless
 * `opts.reCluster` is true.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import { CLUSTERER_AGENT } from '../agents/clusterer.js';
import { SUMMARIZER_AGENT } from '../agents/summarizer.js';
import { DedupeAgent, getKNodeEmbedding } from '../agents/dedupe.js';
import { upsertConcept, newConceptId, setKNodeCluster, membersOf, nearestConcepts, recountAndCentroid, encodeCentroid } from '../knowledge/concept-store.js';
import { scopeFromDomain, dominantGrounding, dominantScope } from '../knowledge/scope.js';
import { mapPool } from '../util/pool.js';
import type { SubstrateNetConfig } from '../config.js';

/**
 * Leaf/evidence kinds are NOT clustered into concepts — they are citations,
 * not ideas. Keeps L3 concepts meaningful (decisions, rules, skills, ...).
 */
const EVIDENCE_KINDS = [
  'path_mention', 'code_block', 'shell_command', 'error_message',
  'stack_trace', 'ticket_id', 'url', 'dependency', 'tool', 'knowledge_gap',
];

export interface ClusterStats {
  processed: number;
  attached: number;
  created: number;
  merged: number;
  conceptsSummarized: number;
}

export interface ClusterOpts {
  reCluster?: boolean;
}

export async function runClustererForNewFacts(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, opts: ClusterOpts = {},
): Promise<ClusterStats> {
  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });

  let dedupe: DedupeAgent | undefined;
  try { dedupe = new DedupeAgent(cfg); } catch { dedupe = undefined; }

  const exclusion = `kind NOT IN (${EVIDENCE_KINDS.map(() => '?').join(',')})`;
  const where = opts.reCluster ? `WHERE ${exclusion}` : `WHERE cluster_id IS NULL AND ${exclusion}`;
  const facts = knowDb.prepare(`
    SELECT id, kind, title, summary FROM k_nodes ${where}
    ORDER BY created_at ASC
  `).all(...EVIDENCE_KINDS) as Array<{ id: string; kind: string; title: string; summary: string | null }>;

  const stats: ClusterStats = { processed: 0, attached: 0, created: 0, merged: 0, conceptsSummarized: 0 };
  const dirty = new Set<string>();

  for (const fact of facts) {
    stats.processed++;

    // Get the fact's embedding (skip facts without one — we can't cluster them).
    const v = getKNodeEmbedding(knowDb, fact.id);
    if (!v) {
      // Without embedding, we still want SOMEWHERE to live. Put in a per-kind concept.
      const fallbackName = `${fact.kind} (uncategorized)`;
      const existing = knowDb.prepare(`SELECT id FROM concepts WHERE name=?`).get(fallbackName) as { id: string } | undefined;
      const cid = existing?.id ?? newConceptId(fallbackName);
      if (!existing) {
        upsertConcept(knowDb, { id: cid, name: fallbackName, summary: undefined, memberCount: 0 });
        stats.created++;
      }
      setKNodeCluster(knowDb, fact.id, cid);
      stats.attached++;
      dirty.add(cid);
      continue;
    }

    // Mechanical candidate pool: top-5 concepts by embedding similarity.
    const candidates = nearestConcepts(knowDb, v, 5, 0.55);

    let action;
    try {
      const out = await rt.run(CLUSTERER_AGENT, {
        payload: {
          fact: { id: fact.id, kind: fact.kind, title: fact.title, summary: fact.summary ?? undefined },
          candidates,
        },
      });
      action = out.output;
    } catch {
      // Backend unavailable: fall back to "create new concept named after fact title".
      action = { action: 'create' as const, suggestedName: fact.title.slice(0, 60), confidence: 0.3, reason: 'fallback' };
    }

    let touched: string | undefined;

    if (action.action === 'attach') {
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
      // create (also acts as fallback when attach/merge couldn't be applied)
      const suggestedName = action.action === 'create' ? action.suggestedName : fact.title.slice(0, 60);
      const cid = newConceptId(suggestedName);
      upsertConcept(knowDb, { id: cid, name: suggestedName, memberCount: 0 });
      setKNodeCluster(knowDb, fact.id, cid);
      touched = cid;
      stats.created++;
      stats.attached++;
    }

    // Incrementally refresh the touched concept's centroid + member count so
    // subsequent facts can find it as a candidate.
    const { memberCount, centroid } = recountAndCentroid(knowDb, touched);
    knowDb.prepare(`UPDATE concepts SET member_count=?, embedding=? WHERE id=?`)
      .run(memberCount, centroid ? encodeCentroid(centroid) : null, touched);

    dirty.add(touched);
  }

  // Re-centroid + summarize each dirty concept. Summarizer calls (independent
  // per concept) run concurrently; persistence stays sequential.
  const limit = cfg.concurrency ?? 4;
  const summarized = await mapPool([...dirty], limit, async (cid) => {
    const members = membersOf(knowDb, cid).slice(0, 25);
    const currentRow = knowDb.prepare(`SELECT name FROM concepts WHERE id=?`).get(cid) as { name: string } | undefined;
    let name = currentRow?.name ?? '';
    let summary: string | undefined;
    let domain: string | undefined;
    let didSummarize = false;
    if (members.length > 0) {
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
        didSummarize = true;
      } catch { /* leave name/summary as-is on backend failure */ }
    }
    return { cid, name, summary, domain, didSummarize };
  });

  for (const s of summarized) {
    const cid = s.cid;
    const { memberCount, centroid } = recountAndCentroid(knowDb, cid);
    const name = s.name;
    const summary = s.summary;
    const domain = s.domain;
    if (s.didSummarize) stats.conceptsSummarized++;

    // Place the concept in the scope x grounding matrix. Scope prefers the
    // members' explicit scope (set by producing agents), falling back to the
    // triage domain. Grounding is the strongest member tier.
    const memberMeta = knowDb.prepare(
      `SELECT grounding, scope FROM k_nodes WHERE cluster_id=?`,
    ).all(cid) as Array<{ grounding: string | null; scope: string | null }>;
    const scope = dominantScope(memberMeta.map((m) => m.scope)) ?? scopeFromDomain(domain);
    const grounding = dominantGrounding(memberMeta.map((m) => m.grounding));

    knowDb.prepare(`
      UPDATE concepts SET name=?, summary=?, domain=?, scope=?, grounding=?, member_count=?, embedding=? WHERE id=?
    `).run(name, summary ?? null, domain ?? null, scope, grounding, memberCount, centroid ? encodeCentroid(centroid) : null, cid);
  }

  return stats;
}
