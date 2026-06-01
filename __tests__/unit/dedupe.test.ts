import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { DedupeAgent, storeWindowEmbedding, storeKNodeEmbedding, getKNodeEmbedding } from '../../src/agents/dedupe';
import { DEFAULT_CONFIG } from '../../src/config';

function makeDedupeWithFakeBackend(vectorFor: Record<string, number[]>): DedupeAgent {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const d = new DedupeAgent(cfg);
  // Override backend with a fake.
  (d as any).backend = {
    async embed({ texts }: { texts: string[] }) {
      return { vectors: texts.map((t) => vectorFor[t] ?? [0, 0, 0]) };
    },
  };
  return d;
}

function seedWindow(db: any, id: string): string {
  const sid = 'sess-' + id;
  const t0 = sid + '-0', t1 = sid + '-1';
  db.prepare(`INSERT OR IGNORE INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
    .run(sid, 'cursor', sid, '/tmp/x.jsonl', Date.now(), 0);
  db.prepare(`INSERT OR IGNORE INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t0, sid, 0, 'user', 'q');
  db.prepare(`INSERT OR IGNORE INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t1, sid, 1, 'assistant', 'a');
  db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
    .run(id, sid, t0, t1, 'h');
  return id;
}

describe('DedupeAgent', () => {
  it('finds the nearest window by cosine similarity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-dd-'));
    const db = openKnowledgeDb(dir);
    try {
      const dedupe = makeDedupeWithFakeBackend({
        canonical: [1, 0, 0],
        twin: [0.99, 0.01, 0],
        unrelated: [0, 1, 0],
      });
      seedWindow(db, 'wA');
      seedWindow(db, 'wB');
      seedWindow(db, 'wC');
      storeWindowEmbedding(db, 'wA', await dedupe.embedText('canonical'));
      storeWindowEmbedding(db, 'wB', await dedupe.embedText('unrelated'));
      const q = await dedupe.embedText('twin');
      const hits = dedupe.nearestWindow(db, q, 5, 0.9, ['wC']);
      expect(hits[0]?.id).toBe('wA');
      expect(hits[0]?.score).toBeGreaterThan(0.99);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores and retrieves k_node embeddings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-dd-'));
    const db = openKnowledgeDb(dir);
    try {
      // need an actual k_node row for FK
      db.prepare(`INSERT INTO k_nodes (id,kind,title,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run('k1', 'decision', 'use redis', 0.9, 'agent:test', Date.now(), Date.now());
      storeKNodeEmbedding(db, 'k1', Float32Array.from([0.1, 0.2, 0.3]), 'test-model');
      const got = getKNodeEmbedding(db, 'k1');
      expect(Array.from(got!)).toEqual([
        // Float32 round-trip introduces tiny error; cast back to JS numbers
        ...new Float32Array([0.1, 0.2, 0.3]),
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
