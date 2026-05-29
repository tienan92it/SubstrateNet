/**
 * Persistence helpers for L2 facts (k_nodes, k_edges, k_provenance).
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import type { KEdge, KNode, KProvenance } from '../types.js';

export function upsertKNode(db: SqliteDb, n: KNode): void {
  db.prepare(`
    INSERT INTO k_nodes
      (id, kind, title, summary, evidence_text, confidence, source, agent_model,
       grounding, created_at, updated_at, cluster_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, summary=excluded.summary,
      evidence_text=excluded.evidence_text, confidence=excluded.confidence,
      source=excluded.source, agent_model=excluded.agent_model,
      grounding=excluded.grounding,
      updated_at=excluded.updated_at
  `).run(
    n.id, n.kind, n.title, n.summary ?? null, n.evidenceText ?? null,
    n.confidence, n.source, n.agentModel ?? null,
    n.grounding ?? null, n.createdAt, n.updatedAt, n.clusterId ?? null,
  );
}

/** Insert a k_edge only if an identical (source, target, kind) edge doesn't exist. */
export function insertKEdgeUnique(db: SqliteDb, e: KEdge): boolean {
  const existing = db.prepare(
    `SELECT 1 FROM k_edges WHERE source=? AND target=? AND kind=? LIMIT 1`,
  ).get(e.source, e.target, e.kind);
  if (existing) return false;
  insertKEdge(db, e);
  return true;
}

export function insertKEdge(db: SqliteDb, e: KEdge): void {
  db.prepare(`
    INSERT INTO k_edges (source, target, kind, weight, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    e.source, e.target, e.kind, e.weight ?? 1,
    e.metadata ? JSON.stringify(e.metadata) : null,
  );
}

export function insertProvenance(db: SqliteDb, p: KProvenance): void {
  db.prepare(`
    INSERT INTO k_provenance (k_node_id, window_id, span_start, span_end)
    VALUES (?, ?, ?, ?)
  `).run(p.kNodeId, p.windowId, p.spanStart ?? null, p.spanEnd ?? null);
}

export function countByKind(db: SqliteDb, source?: string): Record<string, number> {
  const where = source ? `WHERE source = ?` : '';
  const rows = (source
    ? db.prepare(`SELECT kind, COUNT(*) AS n FROM k_nodes ${where} GROUP BY kind`).all(source)
    : db.prepare(`SELECT kind, COUNT(*) AS n FROM k_nodes GROUP BY kind`).all()
  ) as Array<{ kind: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}
