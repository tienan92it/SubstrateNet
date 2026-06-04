/**
 * Global dashboard snapshot builder.
 *
 * Assembles the cross-project knowledge hierarchy from global.db
 * (industry > business domain > tech domain > project) plus a bounded,
 * per-project file graph for drill-down. Self-contained: the static dashboard
 * renders overview-to-detail with no live DB connection.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { existsSync } from 'fs';
import { openGlobalDb } from '../db/connection.js';
import { projectConfigDir } from '../config.js';
import { buildSnapshot, type DashboardSnapshot } from './snapshot.js';
import { industryNodeId, projectNodeId } from '../global/taxonomy.js';
import { listSkills, listIndustries, listHighlights } from '../global/skills.js';

const MAX_EDGES = 4000;

export type HierarchyLevel = 'workspace' | 'industry' | 'business_domain' | 'tech_domain' | 'project' | 'file';

export interface HierarchyNode {
  id: string;
  label: string;
  level: HierarchyLevel;
  summary?: string;
  /** Raw project id (drill-down key) for project-level nodes. */
  projectId?: string;
  /** How many projects this node spans (cross-project weight). */
  projectCount?: number;
  grounding?: string;
}

export interface HierarchyEdge { source: string; target: string; kind: string; }

/** The cross-project "second brain": who the user is across all projects. */
export interface GlobalProfile {
  projectCount: number;
  industries: Array<{ name: string; projectCount: number; confidence: number }>;
  skills: Array<{ name: string; weight: number; projectCount: number; grounding: string }>;
  highlights: Array<{ statement: string; evidence?: string; grounding: string; projectCount: number }>;
}

export interface GlobalDashboardSnapshot {
  meta: {
    mode: 'global';
    generatedAt: number;
    counts: {
      industries: number;
      businessDomains: number;
      techDomains: number;
      projects: number;
      edges: number;
    };
  };
  profile: GlobalProfile;
  hierarchy: { nodes: HierarchyNode[]; edges: HierarchyEdge[] };
  /** Per-project knowledge graphs, keyed by raw project id. */
  drillDown: Record<string, DashboardSnapshot>;
}

/**
 * Build the hierarchy nodes + edges from global.db (pure over the DB handle —
 * no file IO, so it is unit-testable with an in-memory database).
 */
export function assembleHierarchy(gdb: SqliteDb): { nodes: HierarchyNode[]; edges: HierarchyEdge[] } {
  const nodes = new Map<string, HierarchyNode>();

  // Industries (grouped by name across projects).
  const industries = gdb.prepare(`
    SELECT name, COUNT(DISTINCT project_id) AS projects FROM industries GROUP BY lower(name)
  `).all() as Array<{ name: string; projects: number }>;
  for (const i of industries) {
    nodes.set(industryNodeId(i.name), {
      id: industryNodeId(i.name), label: i.name, level: 'industry', projectCount: i.projects,
    });
  }

  // Business domains (id is already name-hashed → merged across projects).
  const biz = gdb.prepare(`
    SELECT id, MIN(name) AS name, MIN(summary) AS summary, MIN(grounding) AS grounding,
           COUNT(DISTINCT project_id) AS projects
    FROM business_domains GROUP BY id
  `).all() as Array<{ id: string; name: string; summary: string | null; grounding: string | null; projects: number }>;
  for (const b of biz) {
    nodes.set(b.id, {
      id: b.id, label: b.name, level: 'business_domain',
      summary: b.summary ?? undefined, grounding: b.grounding ?? undefined, projectCount: b.projects,
    });
  }

  // Tech domains.
  const tech = gdb.prepare(`
    SELECT id, MIN(name) AS name, MIN(summary) AS summary, MIN(grounding) AS grounding,
           COUNT(DISTINCT project_id) AS projects
    FROM tech_domains GROUP BY id
  `).all() as Array<{ id: string; name: string; summary: string | null; grounding: string | null; projects: number }>;
  for (const t of tech) {
    nodes.set(t.id, {
      id: t.id, label: t.name, level: 'tech_domain',
      summary: t.summary ?? undefined, grounding: t.grounding ?? undefined, projectCount: t.projects,
    });
  }

  // Projects.
  const projects = gdb.prepare(`SELECT id, name FROM projects`).all() as Array<{ id: string; name: string }>;
  for (const p of projects) {
    nodes.set(projectNodeId(p.id), {
      id: projectNodeId(p.id), label: p.name, level: 'project', projectId: p.id,
    });
  }

  // Workspace umbrellas (top level) + workspace -> project membership edges.
  const workspaces = gdb.prepare(`
    SELECT w.id AS id, w.name AS name, COUNT(pw.project_id) AS projects
    FROM workspaces w JOIN project_workspace pw ON pw.workspace_id=w.id
    GROUP BY w.id
  `).all() as Array<{ id: string; name: string; projects: number }>;
  for (const w of workspaces) {
    nodes.set(w.id, { id: w.id, label: w.name, level: 'workspace', projectCount: w.projects });
  }
  const membership = gdb.prepare(`SELECT workspace_id, project_id FROM project_workspace`)
    .all() as Array<{ workspace_id: string; project_id: string }>;

  // Edges (deduped across projects; only those with both endpoints present).
  const rawEdges = gdb.prepare(`
    SELECT DISTINCT parent_id AS source, child_id AS target, kind FROM taxonomy_edges
  `).all() as Array<{ source: string; target: string; kind: string }>;
  const seen = new Set<string>();
  const edges: HierarchyEdge[] = [];
  const pushEdge = (source: string, target: string, kind: string) => {
    if (!nodes.has(source) || !nodes.has(target)) return;
    const key = `${source}|${target}`;
    if (seen.has(key) || edges.length >= MAX_EDGES) return;
    seen.add(key);
    edges.push({ source, target, kind });
  };
  // Workspace -> project edges first (the new top level).
  for (const m of membership) pushEdge(m.workspace_id, projectNodeId(m.project_id), 'workspace_has_project');
  for (const e of rawEdges) pushEdge(e.source, e.target, e.kind);

  return { nodes: [...nodes.values()], edges };
}

/** Build the full global snapshot: hierarchy + per-project drill-down graphs. */
export function buildGlobalSnapshot(): GlobalDashboardSnapshot {
  const gdb = openGlobalDb();
  try {
    const { nodes, edges } = assembleHierarchy(gdb);
    const projects = gdb.prepare(`SELECT id, path FROM projects`).all() as Array<{ id: string; path: string }>;

    const profile: GlobalProfile = {
      projectCount: projects.length,
      industries: listIndustries(gdb),
      skills: listSkills(gdb, { scope: 'technical', limit: 40 }).map((s) => ({
        name: s.name, weight: s.evidenceWeight, projectCount: s.projectCount, grounding: s.grounding,
      })),
      highlights: listHighlights(gdb, 40).map((h) => ({
        statement: h.statement, evidence: h.evidence ?? undefined, grounding: h.grounding, projectCount: h.projectCount,
      })),
    };

    const drillDown: Record<string, DashboardSnapshot> = {};
    for (const p of projects) {
      // Only projects that still have local data can be drilled into.
      if (!existsSync(projectConfigDir(p.path))) continue;
      try {
        // Drill-down renders the knowledge graph only; skip the file graph to
        // keep the single-file payload small.
        drillDown[p.id] = buildSnapshot(p.path, { includeFileGraph: false });
      } catch { /* skip projects whose DBs can't be opened */ }
    }

    const count = (level: HierarchyLevel) => nodes.filter((n) => n.level === level).length;
    return {
      meta: {
        mode: 'global',
        generatedAt: Date.now(),
        counts: {
          industries: count('industry'),
          businessDomains: count('business_domain'),
          techDomains: count('tech_domain'),
          projects: count('project'),
          edges: edges.length,
        },
      },
      profile,
      hierarchy: { nodes, edges },
      drillDown,
    };
  } finally {
    gdb.close();
  }
}
