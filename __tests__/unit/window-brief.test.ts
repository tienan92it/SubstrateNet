import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { buildWindowBrief, serializeWindowBrief } from '../../src/pipeline/window-brief';
import { DEFAULT_INGEST_CONFIG } from '../../src/config';

describe('window brief', () => {
  it('builds narrative and verbatim quotes from turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-brief-'));
    const db = openKnowledgeDb(dir);
    try {
      const now = Date.now();
      db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
        .run('s1', 'cursor', 'x', '/t.jsonl', now, 0);
      db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
        .run('s1-0', 's1', 0, 'user', 'We decided to use Redis for session storage.');
      db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
        .run('s1-1', 's1', 1, 'assistant', 'Redis gives cross-instance sessions with TTL.');
      db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
        .run('w1', 's1', 's1-0', 's1-1', 'abc');

      const brief = buildWindowBrief(db, 'w1', DEFAULT_INGEST_CONFIG);
      expect(brief).toBeDefined();
      expect(brief!.quotes.length).toBeGreaterThan(0);
      expect(brief!.narrative).toContain('Redis');
      const ser = serializeWindowBrief(brief!);
      expect(ser).toContain('VERBATIM');
      expect(ser.length).toBeLessThanOrEqual(DEFAULT_INGEST_CONFIG.maxBriefChars + 200);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
