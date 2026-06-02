/**
 * Dashboard snapshot builder.
 *
 * Exports a bounded, self-contained snapshot from the project's SQLite
 * databases. The human-facing artifact is the KNOWLEDGE graph (zones ->
 * concepts/entities -> rules/skills); the file-level dependency graph
 * (`nodes`/`edges`) is retained for agents/tooling (graph.json, MCP) but is
 * not the primary human view. Self-contained — no live DB connection needed.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { basename } from 'path';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';

const DEFAULT_MAX_NODES = 2500;
const DEFAULT_MAX_EDGES = 6000;
const MAX_KNOWLEDGE_NODES = 1500;
const MAX_KNOWLEDGE_EDGES = 3000;

export interface SnapshotOpts {
  /** Cap on file nodes (lower this for global drill-down payloads). */
  maxNodes?: number;
  /** Cap on file-to-file edges. */
  maxEdges?: number;
  /**
   * Include the agent-facing file dependency graph (`nodes`/`edges`). Off for
   * global drill-down payloads, which only render the knowledge graph.
   */
  includeFileGraph?: boolean;
}

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
export interface ConceptItem {
  id: string; name: string; summary?: string; domain?: string; scope?: string;
  structured?: Record<string, string>;
}
export interface SearchItem { id: string; label: string; kind: string; layer?: string; }

/** A node in the human-facing knowledge graph. */
export type KnowledgeLevel = 'business_domain' | 'tech_domain' | 'concept' | 'entity' | 'fact';
export interface KnowledgeNode {
  id: string;
  label: string;
  level: KnowledgeLevel;
  kind: string;          // underlying k_node kind or 'concept'
  summary?: string;
  scope?: string;
  grounding?: string;
}
export interface KnowledgeEdge { source: string; target: string; kind: string; }

export interface DashboardSnapshot {
  meta: {
    project: string;
    generatedAt: number;
    layers: string[];
    counts: {
      files: number; edges: number; highlights: number; concepts: number;
      knowledgeNodes: number; knowledgeEdges: number;
    };
  };
  /** Human-facing knowledge graph (the primary view). */
  knowledge: { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] };
  /** Agent-facing file dependency graph (graph.json / MCP); empty when omitted. */
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

export function buildSnapshot(root: string, opts: SnapshotOpts = {}): DashboardSnapshot {
  const codeDb = openCodeDb(root);
  const knowDb = openKnowledgeDb(root);
  try {
    return assemble(root, codeDb, knowDb, opts);
  } finally {
    codeDb.close();
    knowDb.close();
  }
}

function assemble(root: string, codeDb: SqliteDb, knowDb: SqliteDb, opts: SnapshotOpts): DashboardSnapshot {
  const MAX_NODES = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const MAX_EDGES = opts.maxEdges ?? DEFAULT_MAX_EDGES;
  const includeFileGraph = opts.includeFileGraph ?? true;

  // File dependency graph (agent-facing): nodes colored by layer + import/call
  // edges. Retained in the snapshot for graph.json / MCP, not the human view.
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  if (includeFileGraph) {
    const fileRows = codeDb.prepare(`
      SELECT f.path AS path, f.language AS language,
             fa.layer AS layer, fa.summary AS summary, fa.tags AS tags
      FROM files f
      LEFT JOIN file_analysis fa ON fa.path = f.path
      ORDER BY f.path
      LIMIT ?
    `).all(MAX_NODES) as Array<{ path: string; language: string; layer: string | null; summary: string | null; tags: string | null }>;

    const nodeIds = new Set(fileRows.map((r) => r.path));
    nodes = fileRows.map((r) => ({
      id: r.path,
      label: basename(r.path),
      language: r.language,
      layer: r.layer ?? 'other',
      summary: r.summary ?? undefined,
      tags: parseTags(r.tags),
    }));

    const rawEdges = codeDb.prepare(`
      SELECT DISTINCT s.file_path AS source, t.file_path AS target, e.kind AS kind
      FROM edges e
      JOIN nodes s ON s.id = e.source
      JOIN nodes t ON t.id = e.target
      WHERE e.kind IN ('imports','calls') AND s.file_path != t.file_path
      LIMIT ?
    `).all(MAX_EDGES) as Array<{ source: string; target: string; kind: string }>;
    edges = rawEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  }

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
    SELECT id, name, summary, domain, scope, structured FROM concepts ORDER BY member_count DESC LIMIT 300
  `).all() as Array<{ id: string; name: string; summary: string | null; domain: string | null; scope: string | null; structured: string | null }>)
    .map((r) => ({
      id: r.id, name: r.name, summary: r.summary ?? undefined,
      domain: r.domain ?? undefined, scope: r.scope ?? undefined,
      structured: parseStructured(r.structured),
    }));

  // Human-facing knowledge graph: zones -> concepts/entities -> rules/skills.
  const knowledge = buildKnowledgeGraph(knowDb, concepts);

  // Search index across knowledge nodes, files (if present), concepts, entities.
  const search: SearchItem[] = [
    ...knowledge.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
    ...nodes.map((n) => ({ id: n.id, label: n.label, kind: 'file', layer: n.layer })),
    ...highlights.map((h, i) => ({ id: `hl-${i}`, label: h.statement, kind: 'highlight' })),
  ];

  const layers = [...new Set(nodes.map((n) => n.layer))].sort();

  return {
    meta: {
      project: root,
      generatedAt: Date.now(),
      layers,
      counts: {
        files: nodes.length, edges: edges.length,
        highlights: highlights.length, concepts: concepts.length,
        knowledgeNodes: knowledge.nodes.length, knowledgeEdges: knowledge.edges.length,
      },
    },
    knowledge,
    nodes,
    edges,
    domains: { industries, highlights, entities },
    concepts,
    search,
  };
}

/** k_node kinds promoted into the human knowledge graph, in display priority. */
const KNOWLEDGE_KINDS = [
  'business_domain', 'tech_domain', 'entity',
  'business_rule', 'skill', 'actor', 'process', 'metric', 'glossary_term', 'knowledge_gap',
] as const;

/** Edge kinds that express knowledge structure (containment + relationships). */
const KNOWLEDGE_EDGE_KINDS = [
  'part_of', 'relates_to', 'owned_by', 'governed_by', 'has_state', 'transitions_to', 'depends_on',
];

function knowledgeLevel(kind: string): KnowledgeLevel {
  if (kind === 'business_domain') return 'business_domain';
  if (kind === 'tech_domain') return 'tech_domain';
  if (kind === 'entity') return 'entity';
  return 'fact';
}

/**
 * Assemble the knowledge graph from k_nodes/k_edges + L3 concepts. Zones
 * (business/tech domains) are the hubs; entities and concepts the mid layer;
 * rules/skills/actors/processes the leaves. Edges are containment (`part_of`,
 * concept membership) plus domain relationships.
 */
function buildKnowledgeGraph(
  knowDb: SqliteDb, concepts: ConceptItem[],
): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
  const kindList = KNOWLEDGE_KINDS.map(() => '?').join(',');
  const rows = knowDb.prepare(`
    SELECT id, kind, title, summary, scope, grounding FROM k_nodes
    WHERE kind IN (${kindList})
    ORDER BY CASE kind
      WHEN 'business_domain' THEN 0 WHEN 'tech_domain' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END,
      updated_at DESC
    LIMIT ?
  `).all(...KNOWLEDGE_KINDS, MAX_KNOWLEDGE_NODES) as Array<{
    id: string; kind: string; title: string; summary: string | null; scope: string | null; grounding: string | null;
  }>;

  const nodes: KnowledgeNode[] = rows.map((r) => ({
    id: r.id,
    label: r.title,
    level: knowledgeLevel(r.kind),
    kind: r.kind,
    summary: r.summary ?? undefined,
    scope: r.scope ?? undefined,
    grounding: r.grounding ?? undefined,
  }));

  // Concepts (L3) as mid-level grouping nodes.
  const conceptBudget = Math.max(0, MAX_KNOWLEDGE_NODES - nodes.length);
  for (const c of concepts.slice(0, conceptBudget)) {
    nodes.push({
      id: c.id, label: c.name, level: 'concept', kind: 'concept',
      summary: c.summary, scope: c.scope,
    });
  }

  const present = new Set(nodes.map((n) => n.id));
  const edges: KnowledgeEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (source: string, target: string, kind: string) => {
    if (!present.has(source) || !present.has(target) || source === target) return;
    const key = `${source}|${target}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (edges.length < MAX_KNOWLEDGE_EDGES) edges.push({ source, target, kind });
  };

  // Domain relationships + containment from k_edges.
  const edgeKindList = KNOWLEDGE_EDGE_KINDS.map(() => '?').join(',');
  const kEdges = knowDb.prepare(`
    SELECT source, target, kind FROM k_edges WHERE kind IN (${edgeKindList})
  `).all(...KNOWLEDGE_EDGE_KINDS) as Array<{ source: string; target: string; kind: string }>;
  for (const e of kEdges) pushEdge(e.source, e.target, e.kind);

  // Concept membership: fact -> its concept (only for nodes already present).
  const members = knowDb.prepare(`
    SELECT id, cluster_id FROM k_nodes
    WHERE cluster_id IS NOT NULL AND kind IN (${kindList})
  `).all(...KNOWLEDGE_KINDS) as Array<{ id: string; cluster_id: string }>;
  for (const m of members) pushEdge(m.id, m.cluster_id, 'in_concept');

  return { nodes, edges };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

function parseStructured(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? v : undefined;
  } catch { return undefined; }
}
