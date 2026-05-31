/**
 * `codegps ingest --reprocess` re-runs the agent pipeline over EXISTING
 * windows, not just newly-ingested ones. Verified with a stubbed agent runtime
 * and an isolated HOME (so no real transcripts are discovered → 0 new windows).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { AgentRuntime } from '../../src/agents/runtime';
import { ingestProject } from '../../src/ingest/orchestrator';

let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'cg-home-'));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;          // no ~/.cursor transcripts → 0 discovered
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome; else delete process.env.HOME;
  rmSync(tempHome, { recursive: true, force: true });
});

/** Seed N already-ingested windows (session + turns + windows), offsets at end. */
function seedWindows(root: string, n: number): void {
  const db = openKnowledgeDb(root);
  const sid = 'sess1';
  db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
    .run(sid, 'cursor', sid, '/tmp/x.jsonl', Date.now(), 9999);
  for (let i = 0; i < n; i++) {
    const t0 = `${sid}-${i * 2}`, t1 = `${sid}-${i * 2 + 1}`;
    db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run(t0, sid, i * 2, 'user', `q${i}`);
    db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`).run(t1, sid, i * 2 + 1, 'assistant', `a${i}`);
    db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
      .run(`w${i}`, sid, t0, t1, `h${i}`);
  }
  db.close();
}

function stubRuntime(): { restore: () => void; triagedWindows: string[] } {
  const orig = AgentRuntime.prototype.run;
  const triagedWindows: string[] = [];
  AgentRuntime.prototype.run = async function (agent: any, input: any) {
    if (agent.name === 'triage') triagedWindows.push(input.payload.windowId);
    // One object that satisfies triage (label fields) and extractors (facts:[]).
    return {
      output: {
        relevance: 'on_topic', domain: 'implementation', quality: 'signal',
        linkage: 'this_project', confidence: 0.9, rationale: 'x',
        facts: [], relationships: [], gaps: [], skills: [], items: [],
      },
      confidence: 0.9, model: 'stub', cached: false,
    } as any;
  };
  return { restore: () => { AgentRuntime.prototype.run = orig; }, triagedWindows };
}

describe('ingest --reprocess', () => {
  it('does NOT process existing windows on a normal run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-rp-'));
    seedWindows(root, 3);
    const s = stubRuntime();
    try {
      const stats = await ingestProject(root, { runEnrich: false });
      expect(stats.triaged).toBe(0);          // no new windows → nothing triaged
      expect(s.triagedWindows).toHaveLength(0);
    } finally {
      s.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-triages ALL existing windows with --reprocess', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-rp-'));
    seedWindows(root, 3);
    const s = stubRuntime();
    try {
      const stats = await ingestProject(root, { runEnrich: false, reprocess: true });
      expect(stats.triaged).toBe(3);
      expect(s.triagedWindows.sort()).toEqual(['w0', 'w1', 'w2']);
    } finally {
      s.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
