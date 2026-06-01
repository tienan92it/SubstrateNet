/**
 * Semantic cross-project linking via embeddings + Linker Agent.
 *
 * For each cross-project pair whose concept embeddings are similar above a
 * threshold, ask the Linker Agent to judge the relationship. Persist any
 * non-"none" answers as concept_links rows with source='agent:linker'.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { AgentRuntime } from '../agents/runtime.js';
import { LINKER_AGENT } from '../agents/linker.js';
import { decodeVector, cosine } from '../knowledge/embeddings.js';
import { openKnowledgeDb } from '../db/connection.js';
import type { SubstrateNetConfig } from '../config.js';

export interface SemanticStats {
  candidatePairs: number;
  agentJudged: number;
  linksWritten: number;
  byRelation: Record<string, number>;
}

export async function runSemanticLinking(
  gdb: SqliteDb,
  cfg: SubstrateNetConfig,
  opts: { minSimilarity?: number; maxPairs?: number } = {},
): Promise<SemanticStats> {
  const minSim = opts.minSimilarity ?? 0.78;
  const maxPairs = opts.maxPairs ?? 200;

  const stats: SemanticStats = {
    candidatePairs: 0, agentJudged: 0, linksWritten: 0, byRelation: {},
  };

  const all = gdb.prepare(`
    SELECT id, project_id, name, summary, domain, embedding FROM concepts_global
    WHERE embedding IS NOT NULL
  `).all() as Array<{
    id: string; project_id: string; name: string; summary: string | null;
    domain: string | null; embedding: Buffer;
  }>;

  // Build embeddings index. Pairs are only across projects.
  const vecs = all.map((r) => ({ ...r, v: decodeVector(r.embedding) })).filter((r) => r.v);

  type Candidate = { a: typeof vecs[number]; b: typeof vecs[number]; score: number };
  const candidates: Candidate[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const a = vecs[i], b = vecs[j];
      if (a.project_id === b.project_id) continue;
      const s = cosine(a.v!, b.v!);
      if (s >= minSim) candidates.push({ a, b, score: s });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const trimmed = candidates.slice(0, maxPairs);
  stats.candidatePairs = trimmed.length;

  if (trimmed.length === 0) return stats;

  // The Linker Agent runs against the project's knowledge.db so its cache is
  // stored there. We need a knowledge.db to host the AgentRuntime; we pick
  // ANY project that exposes the first candidate's a-side.
  const firstProjectRow = gdb.prepare(`SELECT path FROM projects WHERE id=?`)
    .get(trimmed[0].a.project_id) as { path: string } | undefined;
  if (!firstProjectRow) return stats;
  const hostKnowDb = openKnowledgeDb(firstProjectRow.path);
  const rt = new AgentRuntime({ knowledgeDb: hostKnowDb, config: cfg });

  const insert = gdb.prepare(`
    INSERT INTO concept_links (a, b, kind, score, source, metadata)
    VALUES (?, ?, ?, ?, 'agent:linker', ?)
    ON CONFLICT(a, b, kind, source) DO UPDATE SET score=excluded.score, metadata=excluded.metadata
  `);

  try {
    for (const cand of trimmed) {
      const aProj = gdb.prepare(`SELECT name FROM projects WHERE id=?`).get(cand.a.project_id) as { name: string } | undefined;
      const bProj = gdb.prepare(`SELECT name FROM projects WHERE id=?`).get(cand.b.project_id) as { name: string } | undefined;
      let result;
      try {
        const out = await rt.run(LINKER_AGENT, {
          payload: {
            a: {
              id: cand.a.id, name: cand.a.name, summary: cand.a.summary ?? undefined,
              domain: cand.a.domain ?? undefined, project: aProj?.name ?? cand.a.project_id,
            },
            b: {
              id: cand.b.id, name: cand.b.name, summary: cand.b.summary ?? undefined,
              domain: cand.b.domain ?? undefined, project: bProj?.name ?? cand.b.project_id,
            },
          },
        });
        result = out.output;
        stats.agentJudged++;
      } catch {
        continue;
      }
      if (result.relation === 'none' || result.confidence < 0.5) continue;
      const [low, high] = cand.a.id < cand.b.id ? [cand.a.id, cand.b.id] : [cand.b.id, cand.a.id];
      insert.run(
        low, high, result.relation, cand.score * result.confidence,
        JSON.stringify({ embedding_sim: cand.score, agent_reason: result.reason }),
      );
      stats.linksWritten++;
      stats.byRelation[result.relation] = (stats.byRelation[result.relation] ?? 0) + 1;
    }
  } finally {
    hostKnowDb.close();
  }
  return stats;
}
