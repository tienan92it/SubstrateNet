/**
 * Deterministic gap detector.
 *
 * Names knowledge gaps that are *factually observable in the graph* and cites
 * the evidence that reveals each. It never fabricates the missing answer — a
 * gap is an open question, recorded as a `knowledge_gap` k_node and linked to
 * the entity it concerns via a `gap_in` edge.
 *
 * Detectors (all evidence-grounded, no inference about the domain itself):
 *   G1 — External reference: an entity referenced by a foreign key but never
 *        defined in this project. Evidence: the FK relationship.
 *   G2 — Ungoverned central entity: an entity that participates in >=1
 *        relationship but no business_rule / constraint anywhere mentions it.
 *        Evidence: its relationships + the absence of a governing rule.
 *
 * Both are statements about the corpus, not guesses about what the rule
 * "should" be.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { KNode } from '../types.js';
import { upsertKNode, insertKEdgeUnique } from '../knowledge/store.js';
import { gapId } from '../knowledge/domain-store.js';

export interface GapStats {
  externalRefs: number;
  ungovernedEntities: number;
}

export function runGapDetector(knowDb: SqliteDb): GapStats {
  const stats: GapStats = { externalRefs: 0, ungovernedEntities: 0 };
  const now = Date.now();

  const emitGap = (key: string, title: string, summary: string, evidence: string, aboutId?: string) => {
    const id = gapId(key);
    const node: KNode = {
      id, kind: 'knowledge_gap', title,
      summary, evidenceText: evidence,
      confidence: 1, source: 'gap:detector', grounding: 'structural',
      createdAt: now, updatedAt: now,
    };
    upsertKNode(knowDb, node);
    if (aboutId) {
      insertKEdgeUnique(knowDb, { source: id, target: aboutId, kind: 'gap_in', weight: 1 });
    }
  };

  const tx = knowDb.transaction(() => {
    // ── G1: external (unmodeled) entities referenced by FK ──────────────
    const externals = knowDb.prepare(`
      SELECT id, title FROM k_nodes
      WHERE kind='entity' AND source='structural:code:external'
    `).all() as Array<{ id: string; title: string }>;

    for (const e of externals) {
      // Who references it?
      const refs = knowDb.prepare(`
        SELECT s.title AS from_title FROM k_edges e
        JOIN k_nodes s ON s.id = e.source
        WHERE e.target=? AND e.kind='relates_to'
      `).all(e.id) as Array<{ from_title: string }>;
      const refList = refs.map((r) => r.from_title).filter(Boolean);
      emitGap(
        `external:${e.id}`,
        `Unmodeled entity referenced by foreign key: ${e.title}`,
        `"${e.title}" is referenced by a foreign key${refList.length ? ` from ${refList.join(', ')}` : ''} but is not defined in this project. Its structure and rules are unknown here.`,
        refList.length ? `FK reference from: ${refList.join(', ')}` : 'foreign key reference',
        e.id,
      );
      stats.externalRefs++;
    }

    // ── G2: central entities with no governing rule ─────────────────────
    // Candidate entities: real (non-external) entities with >=1 relationship.
    const central = knowDb.prepare(`
      SELECT DISTINCT n.id, n.title FROM k_nodes n
      WHERE n.kind='entity' AND n.source != 'structural:code:external'
        AND n.id IN (
          SELECT source FROM k_edges WHERE kind='relates_to'
          UNION SELECT target FROM k_edges WHERE kind='relates_to'
        )
    `).all() as Array<{ id: string; title: string }>;

    for (const e of central) {
      if (!e.title) continue;
      // Does any business_rule / constraint mention this entity by name?
      const mention = knowDb.prepare(`
        SELECT 1 FROM k_nodes
        WHERE kind IN ('business_rule','constraint')
          AND (lower(title) LIKE '%' || lower(?) || '%'
            OR lower(COALESCE(summary,'')) LIKE '%' || lower(?) || '%')
        LIMIT 1
      `).get(e.title, e.title);
      if (mention) continue;

      // Count its relationships (evidence of centrality).
      const relCount = (knowDb.prepare(`
        SELECT COUNT(*) AS n FROM k_edges
        WHERE kind='relates_to' AND (source=? OR target=?)
      `).get(e.id, e.id) as { n: number }).n;

      emitGap(
        `ungoverned:${e.id}`,
        `Entity without documented rules: ${e.title}`,
        `"${e.title}" participates in ${relCount} relationship(s) but no business rule or constraint in the graph references it. The rules governing it are undocumented.`,
        `${relCount} relationship(s); 0 governing rules found`,
        e.id,
      );
      stats.ungovernedEntities++;
    }
  });
  tx();

  return stats;
}
