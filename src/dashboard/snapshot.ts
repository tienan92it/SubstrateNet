/**
 * Dashboard snapshot builder.
 *
 * Exports a bounded, self-contained graph from the project's SQLite databases:
 * a file-level dependency graph (nodes colored by architectural layer), domain
 * highlights/entities, L3 concepts, and a prebuilt search index. This is the
 * single artifact the static dashboard renders — no live DB connection needed.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { basename } from 'path';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';

const MAX_NODES = 2500;
const MAX_EDGES = 6000;

export interface GraphNode {
  id: string;            // file path
  label: string;         // basename
  language: string;
  layer: string;
  summary?: string;
  tags: string[];
}
export interface GraphEdge { source: string; target: string; kind: string; }
export interface DomainHighlightItem { statement: string; evidence?: string; grounding: string; }
export interface ConceptItem { id: string; name: string; summary?: string; domain?: string; scope?: string; }
export interface SearchItem { id: string; label: string; kind: string; layer?: string; }

export interface DashboardSnapshot {
  meta: {
    project: string;
    generatedAt: number;
    layers: string[];
    counts: { files: number; edges: number; highlights: number; concepts: number };
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  domains: {
    industries: Array<{ name: string; evidence?: string }>;
    highlights: DomainHighlightItem[];
    entities: Array<{ id: string; title: string; summary?: string; grounding: string }>;
  };
  concepts: ConceptItem[];
  search: SearchItem[];
}

export function buildSnapshot(root: string): DashboardSnapshot {
  const codeDb = openCodeDb(root);
  const knowDb = openKnowledgeDb(root);
  try {
    return assemble(root, codeDb, knowDb);
  } finally {
    codeDb.close();
    knowDb.close();
  }
}

function assemble(root: string, codeDb: SqliteDb, knowDb: SqliteDb): DashboardSnapshot {
  // File nodes with their semantic overlay (layer/summary/tags).
  const fileRows = codeDb.prepare(`
    SELECT f.path AS path, f.language AS language,
           fa.layer AS layer, fa.summary AS summary, fa.tags AS tags
    FROM files f
    LEFT JOIN file_analysis fa ON fa.path = f.path
    ORDER BY f.path
    LIMIT ?
  `).all(MAX_NODES) as Array<{ path: string; language: string; layer: string | null; summary: string | null; tags: string | null }>;

  const nodeIds = new Set(fileRows.map((r) => r.path));
  const nodes: GraphNode[] = fileRows.map((r) => ({
    id: r.path,
    label: basename(r.path),
    language: r.language,
    layer: r.layer ?? 'other',
    summary: r.summary ?? undefined,
    tags: parseTags(r.tags),
  }));

  // File-to-file dependency edges, derived by mapping symbol-level imports/calls
  // to their containing files and deduping.
  const rawEdges = codeDb.prepare(`
    SELECT DISTINCT s.file_path AS source, t.file_path AS target, e.kind AS kind
    FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
    WHERE e.kind IN ('imports','calls') AND s.file_path != t.file_path
    LIMIT ?
  `).all(MAX_EDGES) as Array<{ source: string; target: string; kind: string }>;
  const edges: GraphEdge[] = rawEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  // Domains: industries, portfolio highlights, top entities.
  const industries = (knowDb.prepare(`SELECT title, evidence_text FROM k_nodes WHERE kind='industry'`)
    .all() as Array<{ title: string; evidence_text: string | null }>)
    .map((r) => ({ name: r.title, evidence: r.evidence_text ?? undefined }));
  const highlights = (knowDb.prepare(`
    SELECT title, evidence_text, COALESCE(grounding,'model') AS grounding FROM k_nodes WHERE kind='domain_highlight'
  `).all() as Array<{ title: string; evidence_text: string | null; grounding: string }>)
    .map((r) => ({ statement: r.title, evidence: r.evidence_text ?? undefined, grounding: r.grounding }));
  const entities = (knowDb.prepare(`
    SELECT id, title, summary, COALESCE(grounding,'stated') AS grounding FROM k_nodes WHERE kind='entity' LIMIT 200
  `).all() as Array<{ id: string; title: string; summary: string | null; grounding: string }>)
    .map((r) => ({ id: r.id, title: r.title, summary: r.summary ?? undefined, grounding: r.grounding }));

  // L3 concepts.
  const concepts = (knowDb.prepare(`
    SELECT id, name, summary, domain, scope FROM concepts ORDER BY member_count DESC LIMIT 300
  `).all() as Array<{ id: string; name: string; summary: string | null; domain: string | null; scope: string | null }>)
    .map((r) => ({ id: r.id, name: r.name, summary: r.summary ?? undefined, domain: r.domain ?? undefined, scope: r.scope ?? undefined }));

  // Search index across files, concepts, entities, highlights.
  const search: SearchItem[] = [
    ...nodes.map((n) => ({ id: n.id, label: n.label, kind: 'file', layer: n.layer })),
    ...concepts.map((c) => ({ id: c.id, label: c.name, kind: 'concept' })),
    ...entities.map((e) => ({ id: e.id, label: e.title, kind: 'entity' })),
    ...highlights.map((h, i) => ({ id: `hl-${i}`, label: h.statement, kind: 'highlight' })),
  ];

  const layers = [...new Set(nodes.map((n) => n.layer))].sort();

  return {
    meta: {
      project: root,
      generatedAt: Date.now(),
      layers,
      counts: { files: nodes.length, edges: edges.length, highlights: highlights.length, concepts: concepts.length },
    },
    nodes,
    edges,
    domains: { industries, highlights, entities },
    concepts,
    search,
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
