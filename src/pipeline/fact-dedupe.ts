/**
 * Cross-source fact deduplication + corroboration.
 *
 * Messy inputs (code, chat, docs, diagrams) restate the same knowledge. This
 * pass collapses near-identical facts of the same kind into one canonical node
 * and, when the duplicates came from independent sources (e.g. stated in a BRD
 * AND discussed in chat, or structural + stated), upgrades the survivor's
 * grounding to `corroborated`. The result is a clean, non-redundant KB.
 *
 * Similarity is embedding cosine at a high threshold; provenance/edges/code
 * links are redirected to the survivor before the duplicate is deleted.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { cosine, decodeVector } from '../knowledge/embeddings.js';

/** Kinds worth deduplicating (stable concepts, not evidence/leaf citations). */
const DEDUPE_KINDS = [
  'entity', 'business_rule', 'requirement', 'feature', 'constraint',
  'actor', 'process', 'metric', 'glossary_term', 'decision',
];

const SIM_THRESHOLD = 0.92;   // high — only fold true near-duplicates
const MAX_PER_KIND = 3000;    // O(n^2) guard

const GROUNDING_RANK: Record<string, number> = {
  corroborated: 4, structural: 3, stated: 2, external: 1, model: 0,
};

const CHAT_AGENTS = new Set(['cursor', 'claude-code', 'codex', 'copilot']);

export interface FactDedupeOpts {
  /** Only dedupe facts not yet assigned to a concept (pre-cluster pass). */
  unclusteredOnly?: boolean;
}

export interface FactDedupeStats { merged: number; corroborated: number; }

interface FactRow { id: string; kind: string; grounding: string; createdAt: number; vec: Float32Array; }

export function runFactDedupe(knowDb: SqliteDb, opts: FactDedupeOpts = {}): FactDedupeStats {
  const stats: FactDedupeStats = { merged: 0, corroborated: 0 };
  for (const kind of DEDUPE_KINDS) {
    const rows = loadFacts(knowDb, kind, opts.unclusteredOnly);
    if (rows.length < 2) continue;
    for (const group of clusterBySimilarity(rows)) {
      if (group.length < 2) continue;
      mergeGroup(knowDb, group, stats);
    }
  }
  return stats;
}

function loadFacts(knowDb: SqliteDb, kind: string, unclusteredOnly?: boolean): FactRow[] {
  const clusterClause = unclusteredOnly ? `AND k.cluster_id IS NULL` : '';
  const rows = knowDb.prepare(`
    SELECT k.id AS id, k.kind AS kind, COALESCE(k.grounding,'stated') AS grounding,
           k.created_at AS createdAt, e.embedding AS emb
    FROM k_nodes k JOIN k_node_embeddings e ON e.k_node_id = k.id
    WHERE k.kind = ? ${clusterClause}
    ORDER BY k.created_at ASC
    LIMIT ?
  `).all(kind, MAX_PER_KIND) as Array<{ id: string; kind: string; grounding: string; createdAt: number; emb: Buffer }>;
  const out: FactRow[] = [];
  for (const r of rows) {
    const v = decodeVector(r.emb);
    if (v) out.push({ id: r.id, kind: r.kind, grounding: r.grounding, createdAt: r.createdAt, vec: v });
  }
  return out;
}

/** Greedy single-link clustering by cosine >= threshold. */
function clusterBySimilarity(rows: FactRow[]): FactRow[][] {
  const used = new Set<number>();
  const groups: FactRow[][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const group = [rows[i]];
    used.add(i);
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(j)) continue;
      if (cosine(rows[i].vec, rows[j].vec) >= SIM_THRESHOLD) {
        group.push(rows[j]);
        used.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

function mergeGroup(knowDb: SqliteDb, group: FactRow[], stats: FactDedupeStats): void {
  // Survivor = strongest grounding, then earliest created.
  const survivor = [...group].sort((a, b) =>
    (GROUNDING_RANK[b.grounding] ?? 0) - (GROUNDING_RANK[a.grounding] ?? 0) || a.createdAt - b.createdAt,
  )[0];
  const dups = group.filter((g) => g.id !== survivor.id);
  if (dups.length === 0) return;

  const ids = group.map((g) => g.id);
  const corroborate = isCorroborated(knowDb, ids, group.map((g) => g.grounding));

  const tx = knowDb.transaction(() => {
    for (const dup of dups) {
      knowDb.prepare(`UPDATE k_provenance SET k_node_id=? WHERE k_node_id=?`).run(survivor.id, dup.id);
      knowDb.prepare(`UPDATE k_to_code SET k_node_id=? WHERE k_node_id=?`).run(survivor.id, dup.id);
      knowDb.prepare(`UPDATE OR IGNORE k_edges SET source=? WHERE source=?`).run(survivor.id, dup.id);
      knowDb.prepare(`UPDATE OR IGNORE k_edges SET target=? WHERE target=?`).run(survivor.id, dup.id);
      // Remove now-self edges created by the redirect.
      knowDb.prepare(`DELETE FROM k_edges WHERE source=target`).run();
      knowDb.prepare(`DELETE FROM k_nodes WHERE id=?`).run(dup.id);
      stats.merged++;
    }
    if (corroborate) {
      const cur = (knowDb.prepare(`SELECT COALESCE(grounding,'stated') AS g FROM k_nodes WHERE id=?`)
        .get(survivor.id) as { g: string } | undefined)?.g ?? 'stated';
      // Only upgrade project-grounded survivors; never overwrite external/model.
      if (cur === 'stated' || cur === 'structural') {
        knowDb.prepare(`UPDATE k_nodes SET grounding='corroborated', updated_at=? WHERE id=?`)
          .run(Date.now(), survivor.id);
        stats.corroborated++;
      }
    }
  });
  tx();
}

/**
 * A merged set is corroborated when its members are backed by INDEPENDENT
 * sources: a structural fact + a stated one, or provenance spanning both a
 * document (`docs`) and a chat agent.
 */
function isCorroborated(knowDb: SqliteDb, ids: string[], groundings: string[]): boolean {
  const gset = new Set(groundings);
  if (gset.has('structural') && gset.has('stated')) return true;

  const placeholders = ids.map(() => '?').join(',');
  const agents = (knowDb.prepare(`
    SELECT DISTINCT s.agent AS agent
    FROM k_provenance p
    JOIN turn_windows w ON w.id = p.window_id
    JOIN sessions s ON s.id = w.session_id
    WHERE p.k_node_id IN (${placeholders})
  `).all(...ids) as Array<{ agent: string }>).map((r) => r.agent);
  const hasDoc = agents.includes('docs');
  const hasChat = agents.some((a) => CHAT_AGENTS.has(a));
  return hasDoc && hasChat;
}
