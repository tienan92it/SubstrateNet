/**
 * Tests for extractor agents + the pipeline that wires them.
 * Uses a fake backend that returns canned JSON per agent call.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb, openCodeDb } from '../../src/db/connection';
import { AgentRuntime } from '../../src/agents/runtime';
import { DECISION_AGENT } from '../../src/agents/decision';
import { BUSINESS_LOGIC_AGENT } from '../../src/agents/business-logic';
import { INTENT_AGENT } from '../../src/agents/intent';
import { PROBLEM_SOLUTION_AGENT } from '../../src/agents/problem-solution';
import { DEFAULT_CONFIG } from '../../src/config';
import { runExtractorsForKeptWindows } from '../../src/pipeline/extract';
import { upsertTriageLabels } from '../../src/knowledge/triage-store';

function seedWindow(db: any, id: string, text: string): void {
  const sid = 'sess-' + id;
  const t0 = sid + '-0', t1 = sid + '-1';
  db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
    .run(sid, 'cursor', sid, '/tmp/x.jsonl', Date.now(), 0);
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t0, sid, 0, 'user', text.split('[assistant]')[0].replace('[user]', '').trim() || 'q');
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t1, sid, 1, 'assistant', text.split('[assistant]')[1]?.trim() || 'a');
  db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
    .run(id, sid, t0, t1, 'h');
}

describe('extractor agents', () => {
  it('Decision Agent filters unknown kinds via postprocess', () => {
    const out = DECISION_AGENT.postprocess!(
      {
        facts: [
          { kind: 'decision', title: 'use redis', confidence: 0.9 },
          { kind: 'business_rule' as any, title: 'sneaky', confidence: 0.9 },
        ],
      },
      { payload: { text: '', windowId: 'w' } },
    );
    expect(out.output.facts).toHaveLength(1);
    expect(out.output.facts[0].kind).toBe('decision');
  });

  it('BusinessLogic Agent allows only business kinds', () => {
    const out = BUSINESS_LOGIC_AGENT.postprocess!(
      {
        facts: [
          { kind: 'business_rule', title: 'refund rule', confidence: 0.9 },
          { kind: 'decision' as any, title: 'use redis', confidence: 0.9 },
        ],
      },
      { payload: { text: '', windowId: 'w' } },
    );
    expect(out.output.facts.map((f) => f.kind)).toEqual(['business_rule']);
  });
});

describe('extract pipeline', () => {
  it('routes domain to correct agents and persists facts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-ex-'));
    const knowDb = openKnowledgeDb(dir);
    const codeDb = openCodeDb(dir);
    try {
      seedWindow(knowDb, 'w1', '[user] refund rules?\n[assistant] Refund must be final after processor returns succeeded.');
      upsertTriageLabels(knowDb, {
        windowId: 'w1', relevance: 'on_topic', domain: 'business_logic',
        quality: 'decision_grade', linkage: 'this_project',
        confidence: 0.9, model: 'test', producedAt: Date.now(), kept: true,
      });

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      // Legacy per-agent fan-out (no unified window extractor configured).
      delete cfg.agents.windowExtractor;
      // Patch AgentRuntime to use a fake backend that returns kind-appropriate JSON
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function (agent: any, _input: any) {
        if (agent.name === 'businessLogic') {
          return {
            output: {
              facts: [
                { kind: 'business_rule', title: 'refund finality', summary: 'final after processor succeeds', confidence: 0.9 },
              ],
            },
            confidence: 0.9, model: 'fake', cached: false,
          } as any;
        }
        if (agent.name === 'decision') {
          return {
            output: { facts: [{ kind: 'decision', title: 'use processor "succeeded" event', confidence: 0.8 }] },
            confidence: 0.8, model: 'fake', cached: false,
          } as any;
        }
        if (agent.name === 'intent') {
          return {
            output: {
              facts: [{
                kind: 'intent', title: 'document refund rules', confidence: 0.7,
                file_mentions: ['src/refund.ts'],
              }],
            },
            confidence: 0.7, model: 'fake', cached: false,
          } as any;
        }
        return { output: { facts: [] }, confidence: 0, model: 'fake', cached: false } as any;
      };

      try {
        const stats = await runExtractorsForKeptWindows(dir, knowDb, codeDb, cfg, ['w1']);
        expect(stats.factsProduced).toBeGreaterThanOrEqual(3);
        expect(stats.factsByAgent.businessLogic).toBe(1);
        expect(stats.factsByAgent.decision).toBe(1);
        expect(stats.factsByAgent.intent).toBe(1);

        const kinds = (knowDb.prepare(`SELECT kind FROM k_nodes`).all() as Array<{ kind: string }>)
          .map((r) => r.kind);
        expect(kinds).toEqual(expect.arrayContaining(['business_rule', 'decision', 'intent']));

        const provCount = (knowDb.prepare(`SELECT COUNT(*) AS n FROM k_provenance WHERE window_id='w1'`).get() as any).n;
        expect(provCount).toBe(stats.factsProduced);
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      knowDb.close();
      codeDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses one unified windowExtractor call per window when configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-ex-'));
    const knowDb = openKnowledgeDb(dir);
    const codeDb = openCodeDb(dir);
    try {
      seedWindow(knowDb, 'w1', '[user] refund rules?\n[assistant] Refund is final after processor succeeds.');
      upsertTriageLabels(knowDb, {
        windowId: 'w1', relevance: 'on_topic', domain: 'business_logic',
        quality: 'decision_grade', linkage: 'this_project',
        confidence: 0.9, model: 'test', producedAt: Date.now(), kept: true,
      });

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // keeps windowExtractor
      const calls: string[] = [];
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function (agent: any) {
        calls.push(agent.name);
        if (agent.name === 'windowExtractor') {
          return {
            output: { facts: [
              { kind: 'business_rule', title: 'refund finality', confidence: 0.9 },
              { kind: 'decision', title: 'use succeeded event', confidence: 0.8 },
            ] },
            confidence: 0.9, model: 'fake', cached: false,
          } as any;
        }
        return { output: { facts: [] }, confidence: 0, model: 'fake', cached: false } as any;
      };
      try {
        const stats = await runExtractorsForKeptWindows(dir, knowDb, codeDb, cfg, ['w1']);
        // Exactly one extractor call, attributed to the unified agent.
        expect(calls.filter((c) => c === 'windowExtractor')).toHaveLength(1);
        expect(calls).not.toContain('businessLogic');
        expect(stats.factsByAgent.windowExtractor).toBe(2);
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      knowDb.close();
      codeDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips windows marked as duplicates by dedupe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-ex-'));
    const knowDb = openKnowledgeDb(dir);
    const codeDb = openCodeDb(dir);
    try {
      seedWindow(knowDb, 'w1', '[user] redis?\n[assistant] yes');
      upsertTriageLabels(knowDb, {
        windowId: 'w1', relevance: 'on_topic', domain: 'architecture',
        quality: 'decision_grade', linkage: 'this_project',
        confidence: 0.9, rationale: '[dup_of:wX]', model: 'test',
        producedAt: Date.now(), kept: true,
      });

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      let called = false;
      const origRun = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function () { called = true; return { output: { facts: [] }, confidence: 0, model: 'fake', cached: false } as any; };
      try {
        await runExtractorsForKeptWindows(dir, knowDb, codeDb, cfg, ['w1']);
        expect(called).toBe(false);
      } finally {
        AgentRuntime.prototype.run = origRun;
      }
    } finally {
      knowDb.close();
      codeDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
