/**
 * Unit tests for MCP query helpers. The MCP server stdio transport is
 * exercised via the smoke test in the CLI build step; here we test the
 * query layer directly.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { recallByQuery, decisionsForTopic, businessLogicForTopic, triageAuditRows, factsForFile } from '../../src/mcp/queries';

function insertFact(db: any, id: string, kind: string, title: string, summary: string) {
  db.prepare(`INSERT INTO k_nodes (id,kind,title,summary,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, kind, title, summary, 0.9, 'agent:test', Date.now(), Date.now());
}

describe('MCP query helpers', () => {
  it('recallByQuery filters by FTS query and kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-mcpq-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, '1', 'decision', 'use redis for sessions', 'cross-instance sharing required');
      insertFact(db, '2', 'business_rule', 'refund finality rule', 'final only after processor returns succeeded');
      insertFact(db, '3', 'decision', 'pick JWT for auth', 'we have many clients');
      const redis = recallByQuery(db, 'redis');
      expect(redis.map((r) => r.id)).toEqual(['1']);
      const decisions = decisionsForTopic(db, 'sessions');
      expect(decisions.length).toBeGreaterThanOrEqual(1);
      const biz = businessLogicForTopic(db, 'refund');
      expect(biz.map((r) => r.id)).toEqual(['2']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('triageAuditRows returns kept and dropped flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-mcpq-'));
    const db = openKnowledgeDb(dir);
    try {
      // seed a window
      db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
        .run('s', 'cursor', 's', '/tmp/x', Date.now(), 0);
      db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run('s-0', 's', 0, 'user', 'q');
      db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run('s-1', 's', 1, 'assistant', 'a');
      db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
        .run('w1', 's', 's-0', 's-1', 'h');
      db.prepare(`INSERT INTO triage_labels (window_id,relevance,domain,quality,linkage,confidence,model,produced_at,kept) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('w1', 'off_topic', 'chitchat', 'noise', 'unrelated', 0.9, 'test', Date.now(), 0);
      const rows = triageAuditRows(db, { droppedOnly: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].kept).toBe(false);
      expect(rows[0].domain).toBe('chitchat');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('factsForFile joins k_nodes via k_to_code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-mcpq-'));
    const db = openKnowledgeDb(dir);
    try {
      insertFact(db, '1', 'decision', 'use feature flag', 'rollout strategy');
      db.prepare(`INSERT INTO k_to_code (k_node_id,code_node_id,code_file,weight) VALUES (?,?,?,?)`)
        .run('1', 'abc123', 'src/auth.ts', 1);
      const out = factsForFile(db, 'src/auth.ts');
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe('decision');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
