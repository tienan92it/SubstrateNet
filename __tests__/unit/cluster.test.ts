/**
 * Tests for the cluster pipeline. Stubs out both the Clusterer Agent
 * (chat) and the Dedupe Agent (embeddings) so the test is deterministic.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { runClustererForNewFacts } from '../../src/pipeline/cluster';
import { storeKNodeEmbedding } from '../../src/agents/dedupe';
import { AgentRuntime } from '../../src/agents/runtime';
import { DEFAULT_CONFIG } from '../../src/config';
import { listConcepts, membersOf } from '../../src/knowledge/concept-store';

function insertFact(db: any, id: string, kind: string, title: string) {
  db.prepare(`INSERT INTO k_nodes (id,kind,title,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, kind, title, 0.9, 'agent:test', Date.now(), Date.now());
}

describe('Cluster pipeline', () => {
  it('creates new concepts when no candidates exist; attaches similar facts to the same concept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-cl-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, 'f1', 'decision', 'use redis for sessions');
      insertFact(db, 'f2', 'decision', 'redis chosen over in-memory cache');
      // Identical embeddings for f1 and f2 → similarity 1.0
      storeKNodeEmbedding(db, 'f1', Float32Array.from([1, 0, 0, 0]));
      storeKNodeEmbedding(db, 'f2', Float32Array.from([1, 0, 0, 0]));

      // Stub agent runtime: clusterer says create for f1, attach for f2.
      let call = 0;
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function (agent: any, input: any) {
        if (agent.name === 'clusterer') {
          call++;
          if (call === 1) {
            return {
              output: { action: 'create', suggestedName: 'session caching', confidence: 0.9, reason: '' },
              confidence: 0.9, model: 'fake', cached: false,
            } as any;
          }
          // second call sees one candidate (from first fact's concept)
          const cand = input.payload.candidates[0];
          if (cand) {
            return {
              output: { action: 'attach', conceptId: cand.id, confidence: 0.9, reason: 'same idea' },
              confidence: 0.9, model: 'fake', cached: false,
            } as any;
          }
          return {
            output: { action: 'create', suggestedName: 'session caching 2', confidence: 0.5, reason: '' },
            confidence: 0.5, model: 'fake', cached: false,
          } as any;
        }
        if (agent.name === 'summarizer') {
          return {
            output: { name: 'session caching', summary: 'Use Redis for session storage across instances.', structured: {} },
            confidence: 0.9, model: 'fake', cached: false,
          } as any;
        }
        return { output: {}, confidence: 0, model: 'fake', cached: false } as any;
      };

      try {
        const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        const stats = await runClustererForNewFacts(db, cfg);
        expect(stats.processed).toBe(2);
        expect(stats.created).toBe(1);
        expect(stats.attached).toBe(2); // both facts attached (one via create, one via attach)
        const concepts = listConcepts(db);
        expect(concepts).toHaveLength(1);
        expect(concepts[0].memberCount).toBe(2);
        expect(concepts[0].summary).toContain('Redis');
        const members = membersOf(db, concepts[0].id);
        expect(members).toHaveLength(2);
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attaches a highly-similar fact mechanically without calling the clusterer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-cl-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, 'f1', 'decision', 'use redis for sessions');
      storeKNodeEmbedding(db, 'f1', Float32Array.from([1, 0, 0, 0]));

      let clustererCalls = 0;
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function (agent: any) {
        if (agent.name === 'clusterer') clustererCalls++;
        if (agent.name === 'summarizer') {
          return { output: { name: 'session caching', summary: 'Redis sessions.', structured: {} }, confidence: 0.9, model: 'fake', cached: false } as any;
        }
        return { output: {}, confidence: 0, model: 'fake', cached: false } as any;
      };
      try {
        const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        // First pass: f1 creates its concept (mechanically — no candidates).
        await runClustererForNewFacts(db, cfg);

        // Second pass: f2 is near-identical to f1's concept centroid, so it
        // attaches mechanically. The clusterer must NOT be consulted.
        insertFact(db, 'f2', 'decision', 'redis chosen for session store');
        storeKNodeEmbedding(db, 'f2', Float32Array.from([1, 0, 0, 0]));
        const stats = await runClustererForNewFacts(db, cfg);

        expect(clustererCalls).toBe(0);
        expect(stats.mechanical).toBe(1);
        expect(stats.attached).toBe(1);
        const concepts = listConcepts(db);
        expect(concepts).toHaveLength(1);
        expect(concepts[0].memberCount).toBe(2);
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses uncategorized concept for facts without embeddings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-cl-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, 'f1', 'todo', 'add login tests');
      // no embedding for f1 → falls into per-kind uncategorized bucket
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function () { return { output: {}, confidence: 0, model: 'fake', cached: false } as any; };
      try {
        const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        const stats = await runClustererForNewFacts(db, cfg);
        expect(stats.created).toBe(1);
        expect(stats.attached).toBe(1);
        const concepts = listConcepts(db);
        expect(concepts[0].name).toBe('todo (uncategorized)');
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
