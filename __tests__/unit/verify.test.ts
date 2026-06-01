import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { runVerify, invalidateStaleTriageCache } from '../../src/pipeline/verify';
import { AgentRuntime } from '../../src/agents/runtime';
import { DEFAULT_CONFIG } from '../../src/config';

function insertFact(db: any, id: string, kind: string, title: string, confidence = 0.9, cluster?: string) {
  db.prepare(`INSERT INTO k_nodes (id,kind,title,confidence,source,created_at,updated_at,cluster_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, kind, title, confidence, 'agent:test', Date.now(), Date.now(), cluster ?? null);
}

describe('verify pipeline', () => {
  it('prunes orphan facts below the confidence threshold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-vf-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, 'low', 'todo', 'tiny noise', 0.1);
      insertFact(db, 'mid', 'todo', 'reasonable',   0.5);
      insertFact(db, 'cluster-low', 'decision', 'in cluster', 0.1, 'c1');
      db.prepare(`INSERT INTO concepts (id,name,member_count) VALUES (?,?,?)`).run('c1', 'c1', 1);

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async () => ({ output: { verdict: 'consistent', confidence: 0.9, reason: '' }, confidence: 0.9, model: 'fake', cached: false } as any);
      try {
        const stats = await runVerify(db, cfg, { pruneBelowConfidence: 0.25 });
        expect(stats.pruned).toBe(1); // 'low' pruned; 'mid' kept (0.5>0.25); 'cluster-low' kept because clustered
        const remaining = (db.prepare(`SELECT id FROM k_nodes`).all() as any[]).map((r) => r.id);
        expect(remaining).toEqual(expect.arrayContaining(['mid', 'cluster-low']));
        expect(remaining).not.toContain('low');
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records contradiction edges when verifier flags them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-vf-'));
    const db = openKnowledgeDb(dir);
    try {
      db.prepare(`INSERT INTO concepts (id,name,member_count) VALUES (?,?,?)`).run('c1', 'auth', 2);
      insertFact(db, 'd1', 'decision', 'use sessions for auth', 0.9, 'c1');
      insertFact(db, 'd2', 'decision', 'use JWT for auth', 0.9, 'c1');

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async () => ({
        output: { verdict: 'b_supersedes_a', confidence: 0.85, reason: 'JWT replaces sessions' },
        confidence: 0.85, model: 'fake', cached: false,
      } as any);
      try {
        const stats = await runVerify(db, cfg);
        expect(stats.supersessionsFound).toBeGreaterThanOrEqual(1);
        const edge = db.prepare(`SELECT source, target, kind FROM k_edges`).get() as any;
        expect(edge.kind).toBe('supersedes');
        expect(edge.source).toBe('d2'); // b supersedes a means d2 supersedes d1
        expect(edge.target).toBe('d1');
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidateStaleTriageCache removes old triage agent_runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-vf-'));
    const db = openKnowledgeDb(dir);
    try {
      const now = Date.now();
      const old = now - 60 * 86_400_000;
      db.prepare(`INSERT INTO agent_runs (id,agent_name,model,input_hash,output_json,ok,produced_at) VALUES (?,?,?,?,?,?,?)`)
        .run('a', 'triage', 'm', 'h1', '{}', 1, old);
      db.prepare(`INSERT INTO agent_runs (id,agent_name,model,input_hash,output_json,ok,produced_at) VALUES (?,?,?,?,?,?,?)`)
        .run('b', 'triage', 'm', 'h2', '{}', 1, now);
      db.prepare(`INSERT INTO agent_runs (id,agent_name,model,input_hash,output_json,ok,produced_at) VALUES (?,?,?,?,?,?,?)`)
        .run('c', 'decision', 'm', 'h3', '{}', 1, old);
      const n = invalidateStaleTriageCache(db, 30);
      expect(n).toBe(1);
      const remaining = (db.prepare(`SELECT id FROM agent_runs ORDER BY id`).all() as any[]).map((r) => r.id);
      expect(remaining).toEqual(['b', 'c']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
