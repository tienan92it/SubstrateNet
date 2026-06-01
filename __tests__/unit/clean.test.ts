/**
 * `subnet clean` cleanup core tests (no LLM).
 *   - global rows for a project are removed via cascade
 *   - the shared skill graph re-aggregates: a skill shared with another
 *     project survives (with reduced count); a skill unique to the removed
 *     project is dropped
 *   - removing one project leaves the other untouched
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb, openGlobalDb } from '../../src/db/connection';
import { syncProject } from '../../src/code/sync';
import { runManifestParser } from '../../src/pipeline/manifests';
import { exportProjectSkills, synthesizeSkills, listSkills, normalizeSkill } from '../../src/global/skills';
import { cleanGlobalProject, countGlobalProject } from '../../src/global/clean';
import { projectIdForPath } from '../../src/global/registry';

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cg-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

async function makeProject(deps: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cg-proj-'));
  writeFileSync(join(root, 'app.ts'), 'export const x = 1;');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }));
  await syncProject(root);
  const know = openKnowledgeDb(root);
  runManifestParser(know, root);
  know.close();
  await exportProjectSkills(root);
  return root;
}

describe('cleanGlobalProject', () => {
  it('removes a project and re-aggregates the skill graph', async () => {
    // Project A: react (unique) + typescript (shared via .ts file)
    // Project B: react (shared) + typescript (shared)
    const a = await makeProject({ react: '^18', leftpad: '^1' });
    const b = await makeProject({ react: '^18' });
    try {
      let gdb = openGlobalDb();
      synthesizeSkills(gdb);

      const react = () => listSkills(gdb, {}).find((s) => normalizeSkill(s.name) === 'react');
      const leftpad = () => listSkills(gdb, {}).find((s) => normalizeSkill(s.name) === 'leftpad');
      expect(react()!.projectCount).toBe(2);
      expect(leftpad()!.projectCount).toBe(1); // only in A

      // Sanity: A is registered with the expected id.
      const counts = countGlobalProject(gdb, a);
      expect(counts.found).toBe(true);
      expect(counts.projectId).toBe(projectIdForPath(a));
      expect(counts.skillEvidence).toBeGreaterThan(0);
      gdb.close();

      // Clean project A.
      gdb = openGlobalDb();
      const removed = cleanGlobalProject(gdb, a);
      expect(removed.skillEvidence).toBeGreaterThan(0);

      // react now belongs to one project; leftpad (unique to A) is gone.
      expect(react()!.projectCount).toBe(1);
      expect(leftpad()).toBeUndefined();

      // Project A row is gone; B remains.
      const projects = gdb.prepare(`SELECT path FROM projects`).all() as Array<{ path: string }>;
      expect(projects.map((p) => p.path)).toEqual([b]);
      // No orphan evidence left for A.
      const aEv = (gdb.prepare(`SELECT COUNT(*) AS n FROM skill_evidence WHERE project_id=?`).get(projectIdForPath(a)) as any).n;
      expect(aEv).toBe(0);
      gdb.close();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('is a no-op for an unregistered path', async () => {
    const gdb = openGlobalDb();
    try {
      const res = cleanGlobalProject(gdb, '/nope/not/registered');
      expect(res.found).toBe(false);
      expect(res.conceptsGlobal).toBe(0);
    } finally { gdb.close(); }
  });
});
