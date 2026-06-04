import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection.js';
import { upsertKNode } from '../../src/knowledge/store.js';
import { storeKNodeEmbedding } from '../../src/agents/dedupe.js';
import { runFactDedupe } from '../../src/pipeline/fact-dedupe.js';

function entity(id: string, title: string, grounding: string): any {
  const now = Date.now();
  return { id, kind: 'entity', title, confidence: 0.9, source: 'agent:test', grounding, scope: 'industry', createdAt: now, updatedAt: now };
}

describe('runFactDedupe', () => {
  it('merges near-identical facts and corroborates across groundings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-dd-'));
    const db = openKnowledgeDb(dir);
    try {
      upsertKNode(db, entity('a', 'Account', 'structural'));
      upsertKNode(db, entity('b', 'Account ', 'stated')); // same concept, different source/grounding
      // Identical embeddings → cosine 1.0 ≥ threshold.
      const v = Float32Array.from([1, 0, 0, 0]);
      storeKNodeEmbedding(db, 'a', v, 'test');
      storeKNodeEmbedding(db, 'b', v, 'test');

      const stats = runFactDedupe(db);
      expect(stats.merged).toBe(1);
      expect(stats.corroborated).toBe(1);

      const rows = db.prepare(`SELECT id, grounding FROM k_nodes WHERE kind='entity'`).all() as Array<{ id: string; grounding: string }>;
      expect(rows).toHaveLength(1);
      // Survivor = the structural one (stronger), upgraded to corroborated.
      expect(rows[0].id).toBe('a');
      expect(rows[0].grounding).toBe('corroborated');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves dissimilar facts untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-dd-'));
    const db = openKnowledgeDb(dir);
    try {
      upsertKNode(db, entity('a', 'Account', 'stated'));
      upsertKNode(db, entity('b', 'Invoice', 'stated'));
      storeKNodeEmbedding(db, 'a', Float32Array.from([1, 0, 0, 0]), 'test');
      storeKNodeEmbedding(db, 'b', Float32Array.from([0, 1, 0, 0]), 'test'); // orthogonal
      const stats = runFactDedupe(db);
      expect(stats.merged).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS n FROM k_nodes WHERE kind='entity'`).get() as any).n).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
