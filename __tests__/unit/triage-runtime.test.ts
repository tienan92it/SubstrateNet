/**
 * End-to-end test for the AgentRuntime + Triage Agent, using a fake backend
 * that returns canned JSON. Exercises:
 *   - schema validation
 *   - cache hit on second call
 *   - persistence to triage_labels
 *   - kept-vs-dropped decision
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openKnowledgeDb } from '../../src/db/connection';
import { AgentRuntime } from '../../src/agents/runtime';
import { TRIAGE_AGENT, shouldKeep, labelsToRow } from '../../src/agents/triage';
import { upsertTriageLabels, getTriageLabels } from '../../src/knowledge/triage-store';
import { DEFAULT_CONFIG } from '../../src/config';

class FakeBackend {
  constructor(public payload: any, public calls = 0) {}
  async chat(_req: any) {
    this.calls++;
    return { content: JSON.stringify(this.payload), tokensIn: 100, tokensOut: 50 };
  }
}

function rt(db: any, payload: any): { runtime: AgentRuntime; backend: FakeBackend } {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const runtime = new AgentRuntime({ knowledgeDb: db, config: cfg });
  const backend = new FakeBackend(payload);
  (runtime as any).backendCache.set('default', backend);
  return { runtime, backend };
}

/** Create the minimum session+turn+window rows for a triage_labels FK to satisfy. */
function seedWindow(db: any, windowId: string): void {
  const sid = 'sess-' + windowId;
  const t0 = sid + '-0';
  const t1 = sid + '-1';
  db.prepare(`INSERT INTO sessions (id,agent,source_id,source_path,ingested_at,ingest_offset) VALUES (?,?,?,?,?,?)`)
    .run(sid, 'cursor', sid, '/tmp/x.jsonl', Date.now(), 0);
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t0, sid, 0, 'user', 'q');
  db.prepare(`INSERT INTO turns (id,session_id,idx,role,text) VALUES (?,?,?,?,?)`)
    .run(t1, sid, 1, 'assistant', 'a');
  db.prepare(`INSERT INTO turn_windows (id,session_id,start_turn,end_turn,text_hash) VALUES (?,?,?,?,?)`)
    .run(windowId, sid, t0, t1, 'h');
}

describe('Triage agent + runtime', () => {
  it('validates output and caches on repeat input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-tri-'));
    const db = openKnowledgeDb(dir);
    try {
      const { runtime, backend } = rt(db, {
        relevance: 'on_topic',
        domain: 'business_logic',
        quality: 'decision_grade',
        linkage: 'this_project',
        activity: 'planning',
        confidence: 0.9,
        rationale: 'explicit business rule about refunds',
      });

      const input = { payload: { text: 'how should we handle refunds...', windowId: 'w1' } };
      const r1 = await runtime.run(TRIAGE_AGENT, input);
      expect(r1.cached).toBe(false);
      expect(r1.output.domain).toBe('business_logic');
      expect(backend.calls).toBe(1);

      const r2 = await runtime.run(TRIAGE_AGENT, input);
      expect(r2.cached).toBe(true);
      expect(backend.calls).toBe(1); // cache hit, no second call
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops chitchat windows with high-confidence labels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-tri-'));
    const db = openKnowledgeDb(dir);
    try {
      const { runtime } = rt(db, {
        relevance: 'off_topic',
        domain: 'chitchat',
        quality: 'noise',
        linkage: 'unrelated',
        activity: 'chitchat',
        confidence: 0.95,
        rationale: 'pure thank-you exchange',
      });
      const out = await runtime.run(TRIAGE_AGENT, {
        payload: { text: '[user] thanks!\n\n[assistant] anytime', windowId: 'w2' },
      });
      const kept = shouldKeep(out.output);
      expect(kept).toBe(false);
      seedWindow(db, 'w2-test');
      upsertTriageLabels(db, labelsToRow('w2-test', out.model, out.output, kept));
      const persisted = getTriageLabels(db, 'w2-test');
      expect(persisted?.kept).toBe(false);
      expect(persisted?.domain).toBe('chitchat');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps decision-grade content even with non-business domain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-tri-'));
    const db = openKnowledgeDb(dir);
    try {
      const { runtime } = rt(db, {
        relevance: 'on_topic',
        domain: 'architecture',
        quality: 'decision_grade',
        linkage: 'this_project',
        activity: 'planning',
        confidence: 0.8,
        rationale: 'pick Redis over in-memory caching',
      });
      const out = await runtime.run(TRIAGE_AGENT, {
        payload: { text: 'should we use redis...', windowId: 'w3' },
      });
      expect(shouldKeep(out.output)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs malformed JSON via retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subnet-tri-'));
    const db = openKnowledgeDb(dir);
    try {
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const runtime = new AgentRuntime({ knowledgeDb: db, config: cfg });
      let call = 0;
      (runtime as any).backendCache.set('default', {
        async chat() {
          call++;
          if (call === 1) {
            return { content: '```json\n{ not valid json' };
          }
          return {
            content: JSON.stringify({
              relevance: 'on_topic', domain: 'implementation', quality: 'signal',
              linkage: 'this_project', activity: 'refactor', confidence: 0.7, rationale: 'normal code talk',
            }),
          };
        },
      });
      const out = await runtime.run(TRIAGE_AGENT, {
        payload: { text: 'rename this function please', windowId: 'w4' },
      });
      expect(out.output.domain).toBe('implementation');
      expect(call).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
