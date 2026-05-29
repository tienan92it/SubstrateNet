/**
 * Domain layer (L2.5) persistence + queries.
 *
 * The domain graph reuses the L2 tables: entities / actors / processes /
 * knowledge_gaps are `k_nodes` with the relevant kind; relationships are
 * `k_edges` with a domain edge kind. This keeps one fact table and one edge
 * table — the "domain model" is a view over them, not a separate store.
 *
 * Every node carries a `grounding` so callers can filter to evidence-backed
 * knowledge only.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import type {
  DomainEntity, DomainRelationship, KnowledgeGap, Grounding, KEdgeKind,
} from '../types.js';

const DOMAIN_ENTITY_KINDS = ['entity', 'actor', 'process', 'metric', 'glossary_term'] as const;

/** Stable id for a domain node derived from a natural key (idempotent re-runs). */
export function domainNodeId(kind: string, key: string): string {
  return createHash('sha1').update(`domain|${kind}|${key.toLowerCase()}`).digest('hex').slice(0, 16);
}

export function gapId(key: string): string {
  return createHash('sha1').update(`gap|${key.toLowerCase()}`).digest('hex').slice(0, 16);
}

/** List domain entities, optionally filtered to a minimum grounding tier or a name fragment. */
export function listEntities(
  db: SqliteDb, opts: { query?: string; limit?: number } = {},
): DomainEntity[] {
  const limit = opts.limit ?? 100;
  const kindList = DOMAIN_ENTITY_KINDS.map(() => '?').join(',');
  const args: any[] = [...DOMAIN_ENTITY_KINDS];
  let where = `WHERE kind IN (${kindList})`;
  if (opts.query) {
    where += ` AND (title LIKE ? OR summary LIKE ?)`;
    args.push(`%${opts.query}%`, `%${opts.query}%`);
  }
  args.push(limit);
  const rows = db.prepare(`
    SELECT id, title, summary, grounding, source
    FROM k_nodes ${where}
    ORDER BY title
    LIMIT ?
  `).all(...args) as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary ?? undefined,
    grounding: (r.grounding ?? 'stated') as Grounding,
    source: r.source,
    codeFiles: codeFilesFor(db, r.id),
  }));
}

export function getEntity(db: SqliteDb, id: string): DomainEntity | undefined {
  const r = db.prepare(`
    SELECT id, title, summary, grounding, source FROM k_nodes WHERE id=?
  `).get(id) as any;
  if (!r) return undefined;
  return {
    id: r.id, title: r.title, summary: r.summary ?? undefined,
    grounding: (r.grounding ?? 'stated') as Grounding, source: r.source,
    codeFiles: codeFilesFor(db, r.id),
  };
}

function codeFilesFor(db: SqliteDb, kNodeId: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT code_file FROM k_to_code WHERE k_node_id=? AND code_file IS NOT NULL
  `).all(kNodeId) as Array<{ code_file: string }>;
  return rows.map((r) => r.code_file);
}

const DOMAIN_EDGE_KINDS: KEdgeKind[] = [
  'relates_to', 'has_state', 'transitions_to', 'governed_by', 'owned_by', 'part_of',
];

/** Relationships touching a given entity (both directions). */
export function relationshipsFor(db: SqliteDb, entityId: string): DomainRelationship[] {
  const kindList = DOMAIN_EDGE_KINDS.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.source, e.target, e.kind, e.metadata,
           s.title AS from_title, t.title AS to_title,
           s.grounding AS from_grounding
    FROM k_edges e
    JOIN k_nodes s ON s.id = e.source
    JOIN k_nodes t ON t.id = e.target
    WHERE (e.source=? OR e.target=?) AND e.kind IN (${kindList})
    ORDER BY e.kind
  `).all(entityId, entityId, ...DOMAIN_EDGE_KINDS) as any[];
  return rows.map((r) => toRelationship(r));
}

/** All domain relationships in the project. */
export function allRelationships(db: SqliteDb, limit = 500): DomainRelationship[] {
  const kindList = DOMAIN_EDGE_KINDS.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.source, e.target, e.kind, e.metadata,
           s.title AS from_title, t.title AS to_title,
           s.grounding AS from_grounding
    FROM k_edges e
    JOIN k_nodes s ON s.id = e.source
    JOIN k_nodes t ON t.id = e.target
    WHERE e.kind IN (${kindList})
    ORDER BY s.title
    LIMIT ?
  `).all(...DOMAIN_EDGE_KINDS, limit) as any[];
  return rows.map((r) => toRelationship(r));
}

function toRelationship(r: any): DomainRelationship {
  const meta = r.metadata ? safeJson(r.metadata) : {};
  return {
    fromId: r.source,
    toId: r.target,
    fromTitle: r.from_title,
    toTitle: r.to_title,
    kind: r.kind as KEdgeKind,
    evidence: meta?.evidence,
    grounding: (meta?.grounding ?? r.from_grounding ?? 'stated') as Grounding,
  };
}

export function listGaps(db: SqliteDb, limit = 100): KnowledgeGap[] {
  const rows = db.prepare(`
    SELECT id, title, summary, evidence_text, grounding, source
    FROM k_nodes WHERE kind='knowledge_gap'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id, title: r.title,
    summary: r.summary ?? undefined,
    evidenceText: r.evidence_text ?? undefined,
    grounding: (r.grounding ?? 'stated') as Grounding,
    source: r.source,
  }));
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
