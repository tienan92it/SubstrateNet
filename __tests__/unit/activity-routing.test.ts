/**
 * Verifies that triage `activity` drives extractor routing — e.g. a bug-fix
 * window runs the problem/solution extractor even when the domain wouldn't.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb, openCodeDb } from '../../src/db/connection.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { runExtractorsForKeptWindows } from '../../src/pipeline/extract.js';
import { upsertTriageLabels } from '../../src/knowledge/triage-store.js';

function seedWindow(db: any, id: string): void {
  const sid = 'sess-' + id;
  db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
    .run(sid, 'cursor', sid, '/tmp/x.jsonl', Date.now(), 0);
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run(sid + '-0', sid, 0, 'user', 'the build crashes');
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run(sid + '-1', sid, 1, 'assistant', 'fixed it');
  db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
    .run(id, sid, sid + '-0', sid + '-1', 'h');
}

describe('activity-driven routing', () => {
  it('runs problemSolution for a bugfix even when domain=meta_process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-act-'));
    const knowDb = openKnowledgeDb(dir);
    const codeDb = openCodeDb(dir);
    const called: string[] = [];
    const orig = AgentRuntime.prototype.run;
    AgentRuntime.prototype.run = async function (agent: any) {
      called.push(agent.name);
      return { output: { facts: [] }, confidence: 0, model: 'fake', cached: false } as any;
    };
    try {
      seedWindow(knowDb, 'w1');
      upsertTriageLabels(knowDb, {
        windowId: 'w1', relevance: 'on_topic', domain: 'meta_process',
        quality: 'signal', linkage: 'this_project', activity: 'bugfix',
        confidence: 0.9, model: 'test', producedAt: Date.now(), kept: true,
      });
      // Exercise the legacy per-agent path so the routing decision is observable.
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      delete cfg.agents.windowExtractor;
      await runExtractorsForKeptWindows(dir, knowDb, codeDb, cfg, ['w1']);
      expect(called).toContain('problemSolution');
    } finally {
      AgentRuntime.prototype.run = orig;
      knowDb.close(); codeDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
