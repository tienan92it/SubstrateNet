/**
 * L5 — global skill graph.
 *
 * Per-project: export this project's technical skills (languages, tools,
 * synthesized skills) and industries into global.db as `skill_evidence` /
 * `industries` rows.
 *
 * Global: `synthesizeSkills` aggregates `skill_evidence` across all projects
 * into `skills` (summed weight, project_count, strongest grounding). A skill
 * with project_count > 1 is, by construction, cross-project — that is the
 * "second brain" view of what the user knows, with how strongly and where.
 *
 * Aggregation is deterministic (group by normalized name). No LLM required.
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { createHash } from 'crypto';
import { openCodeDb, openKnowledgeDb, openGlobalDb } from '../db/connection.js';
import { registerProject } from '../global/registry.js';
import { dominantGrounding } from '../knowledge/scope.js';
import type { Grounding, Scope } from '../types.js';

export interface SkillExportStats {
  projectId: string;
  technicalEvidence: number;
  industries: number;
}

export function normalizeSkill(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function skillId(scope: string, name: string): string {
  return createHash('sha1').update(`skill|${scope}|${normalizeSkill(name)}`).digest('hex').slice(0, 16);
}

const WEIGHT_BY_KIND: Record<string, number> = {
  skill: 3, language: 2, tool: 1, dependency: 0.5,
};

/** Export one project's technical-skill evidence + industries into global.db. */
export async function exportProjectSkills(root: string): Promise<SkillExportStats> {
  const know = openKnowledgeDb(root);
  const code = openCodeDb(root);
  const gdb = openGlobalDb();
  try {
    const projectId = registerProject(gdb, root);
    const now = Date.now();
    const stats: SkillExportStats = { projectId, technicalEvidence: 0, industries: 0 };

    // Collect technical-skill evidence rows: (name, kind, grounding, weight).
    const rows: Array<{ name: string; kind: string; grounding: Grounding; weight: number }> = [];

    // Languages from code.db (objective, structural).
    for (const l of code.prepare(
      `SELECT language AS name, COUNT(*) AS files FROM files GROUP BY language`,
    ).all() as Array<{ name: string; files: number }>) {
      if (!l.name || l.name === 'unknown') continue;
      rows.push({ name: l.name, kind: 'language', grounding: 'structural', weight: Math.min(3, 1 + Math.log10(l.files + 1)) });
    }

    // Synthesized skills + tools + dependencies (scope=technical) from knowledge.db.
    for (const k of know.prepare(`
      SELECT title, kind, COALESCE(grounding,'stated') AS grounding FROM k_nodes
      WHERE scope='technical' AND kind IN ('skill','tool','dependency')
    `).all() as Array<{ title: string; kind: string; grounding: Grounding }>) {
      rows.push({ name: k.title, kind: k.kind, grounding: k.grounding, weight: WEIGHT_BY_KIND[k.kind] ?? 1 });
    }

    // Stub skill row so the evidence FK is satisfied; synthesizeSkills fills weights.
    const stubSkill = gdb.prepare(`
      INSERT INTO skills (id, name, scope, evidence_weight, grounding, project_count, updated_at)
      VALUES (?, ?, 'technical', 0, ?, 0, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const insertEv = gdb.prepare(`
      INSERT INTO skill_evidence (skill_id, project_id, source_name, weight, grounding)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(skill_id, project_id, source_name) DO UPDATE SET weight=excluded.weight, grounding=excluded.grounding
    `);
    const insertIndustry = gdb.prepare(`
      INSERT INTO industries (id, name, project_id, confidence, grounding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, confidence=excluded.confidence, grounding=excluded.grounding, updated_at=excluded.updated_at
    `);
    const insertHighlight = gdb.prepare(`
      INSERT INTO highlights (id, statement, project_id, evidence, grounding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET statement=excluded.statement, evidence=excluded.evidence, grounding=excluded.grounding, updated_at=excluded.updated_at
    `);

    const tx = gdb.transaction(() => {
      // Clear this project's prior technical evidence so re-export is clean.
      gdb.prepare(`DELETE FROM skill_evidence WHERE project_id=?`).run(projectId);
      const seenStub = new Set<string>();
      for (const r of rows) {
        const sid = skillId('technical', r.name);
        if (!seenStub.has(sid)) { stubSkill.run(sid, r.name, r.grounding, now); seenStub.add(sid); }
        insertEv.run(sid, projectId, r.name, r.weight, r.grounding);
        stats.technicalEvidence++;
      }
      // Industries.
      for (const ind of know.prepare(
        `SELECT title, confidence, COALESCE(grounding,'stated') AS grounding FROM k_nodes WHERE kind='industry'`,
      ).all() as Array<{ title: string; confidence: number; grounding: string }>) {
        const id = createHash('sha1').update(`ind|${projectId}|${ind.title.toLowerCase()}`).digest('hex').slice(0, 16);
        insertIndustry.run(id, ind.title, projectId, ind.confidence ?? null, ind.grounding, now);
        stats.industries++;
      }
      // Portfolio highlights (technical x industry).
      gdb.prepare(`DELETE FROM highlights WHERE project_id=?`).run(projectId);
      for (const h of know.prepare(
        `SELECT title, evidence_text, COALESCE(grounding,'model') AS grounding FROM k_nodes WHERE kind='domain_highlight'`,
      ).all() as Array<{ title: string; evidence_text: string | null; grounding: string }>) {
        const id = createHash('sha1').update(`hl|${projectId}|${h.title.toLowerCase()}`).digest('hex').slice(0, 16);
        insertHighlight.run(id, h.title, projectId, h.evidence_text ?? null, h.grounding, now);
      }
    });
    tx();
    return stats;
  } finally {
    know.close(); code.close(); gdb.close();
  }
}

export interface SynthesizeStats { skills: number; crossProject: number; }

/** Aggregate skill_evidence across all projects into the `skills` table. */
export function synthesizeSkills(gdb: SqliteDb): SynthesizeStats {
  const evidence = gdb.prepare(`
    SELECT skill_id, project_id, source_name, weight, grounding FROM skill_evidence
  `).all() as Array<{ skill_id: string; project_id: string; source_name: string; weight: number; grounding: string | null }>;

  // Group by skill_id (already scope+normalized-name keyed).
  const groups = new Map<string, {
    name: string; projects: Set<string>; weight: number; groundings: string[];
  }>();
  for (const e of evidence) {
    let g = groups.get(e.skill_id);
    if (!g) { g = { name: e.source_name, projects: new Set(), weight: 0, groundings: [] }; groups.set(e.skill_id, g); }
    g.projects.add(e.project_id);
    g.weight += e.weight;
    if (e.grounding) g.groundings.push(e.grounding);
  }

  const now = Date.now();
  const upsert = gdb.prepare(`
    INSERT INTO skills (id, name, scope, kind, evidence_weight, grounding, project_count, updated_at)
    VALUES (?, ?, 'technical', NULL, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, evidence_weight=excluded.evidence_weight,
      grounding=excluded.grounding, project_count=excluded.project_count, updated_at=excluded.updated_at
  `);

  let crossProject = 0;
  const tx = gdb.transaction(() => {
    for (const [id, g] of groups) {
      const grounding = dominantGrounding(g.groundings);
      upsert.run(id, g.name, round2(g.weight), grounding, g.projects.size, now);
      if (g.projects.size > 1) crossProject++;
    }
    // Drop skills whose evidence is gone (e.g. after a project re-export).
    gdb.prepare(`DELETE FROM skills WHERE id NOT IN (SELECT DISTINCT skill_id FROM skill_evidence)`).run();
  });
  tx();

  return { skills: groups.size, crossProject };
}

export interface SkillRow {
  id: string; name: string; scope: Scope; kind?: string;
  evidenceWeight: number; grounding: Grounding; projectCount: number;
}

export function listSkills(gdb: SqliteDb, opts: { scope?: string; limit?: number; crossOnly?: boolean } = {}): SkillRow[] {
  const conds: string[] = [];
  const args: any[] = [];
  if (opts.scope) { conds.push('scope=?'); args.push(opts.scope); }
  if (opts.crossOnly) conds.push('project_count > 1');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  args.push(opts.limit ?? 200);
  const rows = gdb.prepare(`
    SELECT id, name, scope, kind, evidence_weight, grounding, project_count
    FROM skills ${where}
    ORDER BY evidence_weight DESC
    LIMIT ?
  `).all(...args) as any[];
  return rows.map((r) => ({
    id: r.id, name: r.name, scope: r.scope, kind: r.kind ?? undefined,
    evidenceWeight: r.evidence_weight, grounding: (r.grounding ?? 'stated') as Grounding,
    projectCount: r.project_count,
  }));
}

export function listHighlights(gdb: SqliteDb, limit = 60): Array<{ statement: string; evidence: string | null; grounding: string; projectCount: number }> {
  const rows = gdb.prepare(`
    SELECT statement, MIN(evidence) AS evidence, MIN(grounding) AS grounding, COUNT(DISTINCT project_id) AS projects
    FROM highlights GROUP BY lower(statement) ORDER BY projects DESC LIMIT ?
  `).all(limit) as Array<{ statement: string; evidence: string | null; grounding: string; projects: number }>;
  return rows.map((r) => ({ statement: r.statement, evidence: r.evidence, grounding: r.grounding, projectCount: r.projects }));
}

export function listIndustries(gdb: SqliteDb): Array<{ name: string; projectCount: number; confidence: number }> {
  const rows = gdb.prepare(`
    SELECT name, COUNT(DISTINCT project_id) AS projects, AVG(confidence) AS conf
    FROM industries GROUP BY lower(name) ORDER BY projects DESC, conf DESC
  `).all() as Array<{ name: string; projects: number; conf: number }>;
  return rows.map((r) => ({ name: r.name, projectCount: r.projects, confidence: r.conf ?? 0 }));
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
