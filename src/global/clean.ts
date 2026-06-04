/**
 * Cleanup core for `subnet clean`.
 *
 * Separated from the CLI so it is testable without spawning the binary.
 * Global deletes rely on the FK cascade (the connection opens with
 * `foreign_keys = ON`): removing a `projects` row cascades to
 * `concepts_global`, `concept_links`, `skill_evidence`, `industries`,
 * `business_domains`, `tech_domains`, `taxonomy_edges`, `project_workspace`,
 * and `project_links`. Cross-project aggregates — `skills` and `workspaces` —
 * are fixed afterward (`synthesizeSkills` drops orphaned skills; empty
 * workspaces are pruned on the next `subnet link`).
 */
import type { Database as SqliteDb } from 'better-sqlite3';
import { projectIdForPath } from './registry.js';
import { synthesizeSkills } from './skills.js';

export interface GlobalProjectCounts {
  found: boolean;
  projectId: string;
  path?: string;
  conceptsGlobal: number;
  conceptLinks: number;
  skillEvidence: number;
  industries: number;
}

/** Resolve a project row by id (sha1 of path) or exact stored path. */
function resolveProject(gdb: SqliteDb, root: string): { id: string; path: string } | undefined {
  const id = projectIdForPath(root);
  const row = gdb.prepare(`SELECT id, path FROM projects WHERE id=? OR path=? LIMIT 1`)
    .get(id, root) as { id: string; path: string } | undefined;
  return row;
}

export function countGlobalProject(gdb: SqliteDb, root: string): GlobalProjectCounts {
  const proj = resolveProject(gdb, root);
  const id = proj?.id ?? projectIdForPath(root);
  const n = (sql: string) => (gdb.prepare(sql).get(id) as { n: number } | undefined)?.n ?? 0;
  return {
    found: !!proj,
    projectId: id,
    path: proj?.path,
    conceptsGlobal: n(`SELECT COUNT(*) AS n FROM concepts_global WHERE project_id=?`),
    conceptLinks: (gdb.prepare(`
      SELECT COUNT(*) AS n FROM concept_links
      WHERE a IN (SELECT id FROM concepts_global WHERE project_id=?)
         OR b IN (SELECT id FROM concepts_global WHERE project_id=?)
    `).get(id, id) as { n: number }).n,
    skillEvidence: n(`SELECT COUNT(*) AS n FROM skill_evidence WHERE project_id=?`),
    industries: n(`SELECT COUNT(*) AS n FROM industries WHERE project_id=?`),
  };
}

/**
 * Delete one project's rows from global.db and re-aggregate the skill graph.
 * Returns the counts that were present before deletion.
 */
export function cleanGlobalProject(gdb: SqliteDb, root: string): GlobalProjectCounts {
  const counts = countGlobalProject(gdb, root);
  if (!counts.found && counts.conceptsGlobal === 0 && counts.skillEvidence === 0 && counts.industries === 0) {
    return counts; // nothing registered for this path
  }
  const tx = gdb.transaction(() => {
    gdb.prepare(`DELETE FROM projects WHERE id=?`).run(counts.projectId);
  });
  tx();
  // Re-aggregate: drops orphaned skills, recomputes weights/project_count.
  synthesizeSkills(gdb);
  return counts;
}

/** All registered project paths (used by `clean --all`). */
export function listProjectPaths(gdb: SqliteDb): Array<{ id: string; name: string; path: string }> {
  return gdb.prepare(`SELECT id, name, path FROM projects ORDER BY path`).all() as Array<{ id: string; name: string; path: string }>;
}
