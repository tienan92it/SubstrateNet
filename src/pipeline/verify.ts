/**
 * Verify pipeline.
 *
 *   1. Prune low-confidence orphan facts.
 *   2. For each cluster with multiple facts of the SAME kind among
 *      {decision, business_rule, constraint, pattern}, sample pairs and ask
 *      the Verifier Agent. Persist `contradicts` / `supersedes` edges.
 *   3. Re-trigger triage for windows whose labels are older than `staleDays`
 *      and whose backing turn text has changed (rare; mostly a hook).
 *
 * Run via `subnet verify` (CLI subcommand) or `subnet_verify` MCP tool.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import { VERIFIER_AGENT } from '../agents/verifier.js';
import type { SubstrateNetConfig } from '../config.js';

export interface VerifyStats {
  pruned: number;
  pairsChecked: number;
  contradictionsFound: number;
  supersessionsFound: number;
}

export interface VerifyOpts {
  pruneBelowConfidence?: number;
  maxPairsPerCluster?: number;
}

export async function runVerify(
  knowDb: SqliteDb, cfg: SubstrateNetConfig, opts: VerifyOpts = {},
): Promise<VerifyStats> {
  const minConf = opts.pruneBelowConfidence ?? 0.25;
  const maxPairs = opts.maxPairsPerCluster ?? 5;
  const stats: VerifyStats = { pruned: 0, pairsChecked: 0, contradictionsFound: 0, supersessionsFound: 0 };

  // 1. Prune low-confidence orphans (no edges, no code links, no cluster).
  const prune = knowDb.prepare(`
    DELETE FROM k_nodes
    WHERE confidence < ?
      AND cluster_id IS NULL
      AND id NOT IN (SELECT source FROM k_edges UNION SELECT target FROM k_edges)
      AND id NOT IN (SELECT k_node_id FROM k_to_code)
  `).run(minConf);
  stats.pruned = prune.changes;

  // 2. Pairwise verifier across multi-fact clusters.
  const rt = new AgentRuntime({ knowledgeDb: knowDb, config: cfg });
  const clusters = knowDb.prepare(`
    SELECT cluster_id AS cid
    FROM k_nodes
    WHERE cluster_id IS NOT NULL
      AND kind IN ('decision','business_rule','constraint','pattern')
    GROUP BY cluster_id
    HAVING COUNT(*) >= 2
  `).all() as Array<{ cid: string }>;

  const insertEdge = knowDb.prepare(`
    INSERT INTO k_edges (source, target, kind, weight, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const { cid } of clusters) {
    const facts = knowDb.prepare(`
      SELECT id, kind, title, summary, created_at AS ts
      FROM k_nodes
      WHERE cluster_id=? AND kind IN ('decision','business_rule','constraint','pattern')
      ORDER BY created_at ASC
    `).all(cid) as Array<{ id: string; kind: string; title: string; summary: string | null; ts: number }>;

    let pairsForCluster = 0;
    pairLoop:
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        if (pairsForCluster >= maxPairs) break pairLoop;
        // Only verify same-kind pairs (a decision vs a decision, etc.)
        if (facts[i].kind !== facts[j].kind) continue;
        pairsForCluster++;
        stats.pairsChecked++;
        let out;
        try {
          out = await rt.run(VERIFIER_AGENT, {
            payload: {
              a: { id: facts[i].id, kind: facts[i].kind, title: facts[i].title, summary: facts[i].summary ?? undefined, ts: facts[i].ts },
              b: { id: facts[j].id, kind: facts[j].kind, title: facts[j].title, summary: facts[j].summary ?? undefined, ts: facts[j].ts },
            },
          });
        } catch { continue; }

        const v = out.output;
        if (v.confidence < 0.6) continue;
        if (v.verdict === 'contradicts') {
          insertEdge.run(facts[i].id, facts[j].id, 'contradicts', v.confidence, JSON.stringify({ reason: v.reason }));
          stats.contradictionsFound++;
        } else if (v.verdict === 'a_supersedes_b') {
          insertEdge.run(facts[i].id, facts[j].id, 'supersedes', v.confidence, JSON.stringify({ reason: v.reason }));
          stats.supersessionsFound++;
        } else if (v.verdict === 'b_supersedes_a') {
          insertEdge.run(facts[j].id, facts[i].id, 'supersedes', v.confidence, JSON.stringify({ reason: v.reason }));
          stats.supersessionsFound++;
        }
      }
    }
  }

  return stats;
}

/**
 * Mark triage labels as stale (just clear the agent_runs cache entry so a
 * future ingest re-runs the Triage Agent).
 */
export function invalidateStaleTriageCache(knowDb: SqliteDb, staleDays = 30): number {
  const cutoff = Date.now() - staleDays * 86_400_000;
  const res = knowDb.prepare(`
    DELETE FROM agent_runs WHERE agent_name='triage' AND produced_at < ?
  `).run(cutoff);
  return res.changes;
}
