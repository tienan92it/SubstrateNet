/**
 * Top-level L4 link rebuild: export concepts → mechanical → semantic.
 */
import { loadConfig } from '../config.js';
import { openGlobalDb } from '../db/connection.js';
import { exportProjectConcepts, globalConceptId } from './export.js';
import { runMechanicalLinking } from './mechanical.js';
import { runSemanticLinking } from './semantic.js';
import { projectIdForPath } from '../global/registry.js';
import { exportProjectSkills, synthesizeSkills } from '../global/skills.js';
import { exportProjectTaxonomy } from '../global/taxonomy.js';

export interface LinkStats {
  exported: number;
  mechanical: number;
  semantic: number;
  skills: number;
  crossProjectSkills: number;
  businessDomains: number;
  techDomains: number;
}

export async function rebuildLinks(root: string, opts: { full?: boolean } = {}): Promise<LinkStats> {
  const cfg = loadConfig(root);
  const exp = await exportProjectConcepts(root);
  // Export this project's technical-skill evidence + industries into global.db.
  await exportProjectSkills(root);
  // Export this project's knowledge zones + global hierarchy edges.
  const tax = exportProjectTaxonomy(root);
  const gdb = openGlobalDb();
  try {
    if (opts.full) {
      gdb.prepare(`DELETE FROM concept_links`).run();
    }
    const mech = runMechanicalLinking(gdb);
    let semantic = 0;
    try {
      const sem = await runSemanticLinking(gdb, cfg);
      semantic = sem.linksWritten;
    } catch {
      // Backend down: mechanical-only result is still useful.
    }
    // Aggregate skill evidence across all projects into the global skill graph.
    const synth = synthesizeSkills(gdb);
    return {
      exported: exp.conceptsExported,
      mechanical: mech.linksWritten,
      semantic,
      skills: synth.skills,
      crossProjectSkills: synth.crossProject,
      businessDomains: tax.businessDomains,
      techDomains: tax.techDomains,
    };
  } finally {
    gdb.close();
  }
}

/**
 * Return concepts in OTHER projects related to the given local concept.
 */
export function listCrossProjectLinks(localConceptId: string, projectRoot: string): Array<{
  globalId: string; relation: string; score: number; otherProject: string;
  otherName: string; otherSummary?: string;
}> {
  const gdb = openGlobalDb();
  try {
    const gid = globalConceptId(projectIdForPath(projectRoot), localConceptId);
    const rows = gdb.prepare(`
      SELECT cl.kind AS relation, cl.score AS score,
             other.id AS otherId, other.name AS otherName, other.summary AS otherSummary,
             p.name AS otherProject
      FROM concept_links cl
      JOIN concepts_global other ON other.id = CASE WHEN cl.a=? THEN cl.b ELSE cl.a END
      JOIN projects p ON p.id = other.project_id
      WHERE cl.a=? OR cl.b=?
      ORDER BY cl.score DESC
    `).all(gid, gid, gid) as any[];
    return rows.map((r) => ({
      globalId: r.otherId,
      relation: r.relation,
      score: r.score,
      otherProject: r.otherProject,
      otherName: r.otherName,
      otherSummary: r.otherSummary ?? undefined,
    }));
  } finally {
    gdb.close();
  }
}
