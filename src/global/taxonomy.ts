/**
 * Export a project's knowledge zones (business + tech domains) and the global
 * hierarchy edges (industry > business domain > tech domain > project) into
 * global.db. Domain node ids are name-hashes, so the same domain across
 * projects collapses to one hierarchy node (mechanical cross-project merge).
 */
import { createHash } from 'crypto';
import { openKnowledgeDb, openGlobalDb } from '../db/connection.js';
import { registerProject } from './registry.js';

export interface TaxonomyExportStats {
  projectId: string;
  businessDomains: number;
  techDomains: number;
  edges: number;
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export function industryNodeId(name: string): string { return `ind:${hash(name.toLowerCase())}`; }
export function businessDomainNodeId(name: string): string { return `bd:${hash(name.toLowerCase())}`; }
export function techDomainNodeId(name: string): string { return `td:${hash(name.toLowerCase())}`; }
export function projectNodeId(projectId: string): string { return `proj:${projectId}`; }

/** Export one project's domains + hierarchy edges into global.db. */
export function exportProjectTaxonomy(root: string): TaxonomyExportStats {
  const know = openKnowledgeDb(root);
  const gdb = openGlobalDb();
  try {
    const projectId = registerProject(gdb, root);
    const now = Date.now();
    const stats: TaxonomyExportStats = { projectId, businessDomains: 0, techDomains: 0, edges: 0 };

    const industries = (know.prepare(
      `SELECT DISTINCT title FROM k_nodes WHERE kind='industry'`,
    ).all() as Array<{ title: string }>).map((r) => r.title);

    const bizRows = know.prepare(
      `SELECT title, summary, COALESCE(grounding,'stated') AS grounding FROM k_nodes WHERE kind='business_domain'`,
    ).all() as Array<{ title: string; summary: string | null; grounding: string }>;
    const techRows = know.prepare(
      `SELECT title, summary, COALESCE(grounding,'stated') AS grounding FROM k_nodes WHERE kind='tech_domain'`,
    ).all() as Array<{ title: string; summary: string | null; grounding: string }>;

    const insertBiz = gdb.prepare(`
      INSERT INTO business_domains (id, project_id, name, summary, grounding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, project_id) DO UPDATE SET name=excluded.name, summary=excluded.summary, grounding=excluded.grounding, updated_at=excluded.updated_at
    `);
    const insertTech = gdb.prepare(`
      INSERT INTO tech_domains (id, project_id, name, summary, grounding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, project_id) DO UPDATE SET name=excluded.name, summary=excluded.summary, grounding=excluded.grounding, updated_at=excluded.updated_at
    `);
    const insertEdge = gdb.prepare(`
      INSERT INTO taxonomy_edges (parent_id, child_id, kind, project_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(parent_id, child_id, project_id) DO UPDATE SET kind=excluded.kind
    `);

    const tx = gdb.transaction(() => {
      // Re-export cleanly for this project.
      gdb.prepare(`DELETE FROM business_domains WHERE project_id=?`).run(projectId);
      gdb.prepare(`DELETE FROM tech_domains WHERE project_id=?`).run(projectId);
      gdb.prepare(`DELETE FROM taxonomy_edges WHERE project_id=?`).run(projectId);

      for (const b of bizRows) {
        insertBiz.run(businessDomainNodeId(b.title), projectId, b.title, b.summary, b.grounding, now);
        stats.businessDomains++;
      }
      for (const t of techRows) {
        insertTech.run(techDomainNodeId(t.title), projectId, t.title, t.summary, t.grounding, now);
        stats.techDomains++;
      }

      // Build the level chain present for THIS project, then connect consecutive
      // levels (collapsing gaps), ending at the project node.
      const chain: Array<{ level: string; ids: string[] }> = [];
      if (industries.length) chain.push({ level: 'industry', ids: industries.map(industryNodeId) });
      if (bizRows.length) chain.push({ level: 'business', ids: bizRows.map((b) => businessDomainNodeId(b.title)) });
      if (techRows.length) chain.push({ level: 'tech', ids: techRows.map((t) => techDomainNodeId(t.title)) });
      chain.push({ level: 'project', ids: [projectNodeId(projectId)] });

      for (let i = 0; i + 1 < chain.length; i++) {
        const parent = chain[i];
        const child = chain[i + 1];
        const kind = `${parent.level}_has_${child.level}`;
        for (const p of parent.ids) {
          for (const c of child.ids) {
            insertEdge.run(p, c, kind, projectId);
            stats.edges++;
          }
        }
      }
    });
    tx();
    return stats;
  } finally {
    know.close();
    gdb.close();
  }
}
