import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCodeDb, openKnowledgeDb } from '../../src/db/connection';

describe('db connection', () => {
  it('opens code.db and creates expected tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-test-'));
    try {
      const db = openCodeDb(dir);
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all()
        .map((r: any) => r.name);
      expect(tables).toContain('nodes');
      expect(tables).toContain('edges');
      expect(tables).toContain('files');
      expect(tables).toContain('unresolved_refs');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens knowledge.db with L1, L1.5, L2, L3, agent_runs tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-test-'));
    try {
      const db = openKnowledgeDb(dir);
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all()
        .map((r: any) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'sessions', 'turns', 'tool_calls',
          'turn_windows', 'triage_labels',
          'k_nodes', 'k_edges', 'k_provenance', 'k_to_code',
          'concepts', 'agent_runs',
        ]),
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
