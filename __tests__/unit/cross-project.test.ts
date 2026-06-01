/**
 * Tests for the cross-project linking pipeline. Uses temp HOME so the
 * global DB lives in an isolated location for each test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { exportProjectConcepts } from '../../src/link/export';
import { rebuildLinks, listCrossProjectLinks } from '../../src/link/cross-project';

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'subnet-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

function seedProject(rootName: string, conceptName: string, summary: string): string {
  const root = mkdtempSync(join(tmpdir(), `subnet-proj-${rootName}-`));
  const db = openKnowledgeDb(root);
  db.prepare(`INSERT INTO concepts (id,name,summary,domain,member_count,embedding) VALUES (?,?,?,?,?,NULL)`)
    .run('c1', conceptName, summary, 'architecture', 1);
  db.close();
  return root;
}

describe('cross-project linking', () => {
  it('exports concepts into global DB and links exact-name matches mechanically', async () => {
    const projA = seedProject('a', 'session caching', 'use redis for sessions');
    const projB = seedProject('b', 'Session Caching', 'redis-backed session store');
    try {
      await exportProjectConcepts(projA);
      await exportProjectConcepts(projB);

      const stats = await rebuildLinks(projA);
      expect(stats.exported).toBe(1);
      // mechanical should have linked the two (case-insensitive same name)
      expect(stats.mechanical).toBeGreaterThanOrEqual(1);

      const linksA = listCrossProjectLinks('c1', projA);
      expect(linksA.length).toBeGreaterThanOrEqual(1);
      expect(linksA[0].relation).toBe('same_as');
      const linksB = listCrossProjectLinks('c1', projB);
      expect(linksB.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  it('returns no links when no other project has matching concepts', async () => {
    const projA = seedProject('a', 'unique concept', 'no sibling');
    try {
      await exportProjectConcepts(projA);
      await rebuildLinks(projA);
      const links = listCrossProjectLinks('c1', projA);
      expect(links).toHaveLength(0);
    } finally {
      rmSync(projA, { recursive: true, force: true });
    }
  });
});
