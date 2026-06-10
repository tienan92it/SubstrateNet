/**
 * L6 wisdom synthesis tests (deterministic, no LLM), post-PARA refactor:
 *   - deterministicWisdom builds headline/narrative/insights/gaps from organized areas
 *   - synthesizeWisdom + listWisdom round-trip with no usable backend
 *   - WisdomSynthesizer agent postprocess coercion (v2: no competencies)
 *
 * Competency grouping + level bucketing now live in organize.test.ts.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deterministicWisdom, synthesizeWisdom, listWisdom } from '../../src/global/wisdom.js';
import {
  WISDOM_SYNTHESIZER_AGENT, type WisdomSynthesizerPayload,
} from '../../src/agents/wisdom-synthesizer.js';

function seedGlobalDb() {
  const db = new Database(':memory:');
  const schema = readFileSync(join(__dirname, '..', '..', 'src', 'db', 'global-schema.sql'), 'utf8');
  db.exec(schema);
  const now = Date.now();
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p1', 'alpha', '/tmp/subnet-wisdom-test-alpha-zzz', now, now);

  const skill = db.prepare(`INSERT INTO skills (id,name,scope,kind,evidence_weight,grounding,project_count,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  skill.run('s1', 'react', 'technical', 'framework', 8, 'structural', 2, now);
  skill.run('s2', 'postgres', 'technical', 'tool', 6, 'corroborated', 2, now);
  skill.run('s4', 'docker', 'technical', 'tool', 5, 'structural', 3, now);

  // Pre-seed an organized area (normally written by the organizer) so wisdom has input.
  db.prepare(`INSERT INTO competency_groups (id,name,category,level,summary,weight,project_count,grounding,rank,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('cg1', 'Tooling & Infrastructure', null, 'proficient', 'tools', 11, 3, 'structural', 0, now);

  db.prepare(`INSERT INTO industries (id,name,project_id,confidence,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('i1', 'Fintech', 'p1', 0.9, 'stated', now);
  return db;
}

/** A config whose only backend has no resolvable key → forces deterministic. */
const NO_BACKEND_CFG = {
  agentBackends: { openrouter: { kind: 'openai-compatible', apiKeyEnv: 'SUBNET_TEST_NO_KEY_ZZZ' } },
  agents: { wisdomSynthesizer: { model: 'openrouter:test-model' } },
} as any;

describe('deterministicWisdom', () => {
  const payload: WisdomSynthesizerPayload = {
    projectCount: 2,
    industries: [{ name: 'Fintech', projectCount: 2 }],
    skills: [
      { name: 'react', weight: 8, grounding: 'structural', projectCount: 2 },
      { name: 'docker', weight: 5, grounding: 'structural', projectCount: 3 },
    ],
    areas: [
      { name: 'Frameworks', level: 'proficient', summary: 'x' },
      { name: 'Tooling & Infrastructure', level: 'expert', summary: 'y' },
    ],
    businessDomains: [], techDomains: [], concepts: [],
    highlights: [{ statement: 'Built a payments ledger', grounding: 'corroborated' }],
    gaps: [{ title: 'Ungoverned entity: Ledger', summary: 'no governing rule' }],
  };

  it('builds a headline anchored on the strongest areas', () => {
    const out = deterministicWisdom(payload);
    expect(out.headline).toBeTruthy();
    // Strongest area (expert) should lead.
    expect(out.headline).toContain('Tooling & Infrastructure');
    expect(out.narrative).toContain('2 competency area');
  });

  it('passes gaps through with a recommendation and derives insights', () => {
    const out = deterministicWisdom(payload);
    expect(out.gaps[0].title).toBe('Ungoverned entity: Ledger');
    expect(out.gaps[0].recommendation).toBeTruthy();
    expect(out.insights.some((i) => i.title === 'Consistent cross-project strengths')).toBe(true);
    // v2: no competencies on the wisdom output.
    expect((out as Record<string, unknown>).competencies).toBeUndefined();
  });
});

describe('synthesizeWisdom + listWisdom', () => {
  it('persists a deterministic layer when no LLM backend is usable', async () => {
    const db = seedGlobalDb();
    try {
      const stats = await synthesizeWisdom(db, NO_BACKEND_CFG);
      expect(stats.source).toBe('deterministic');

      const w = listWisdom(db);
      expect(w.headline).toBeTruthy();
      expect(w.grounding).toBe('model');
      expect(w.insights.length).toBe(stats.insights);
      expect(w.gaps.length).toBe(stats.gaps);
    } finally {
      db.close();
    }
  });

  it('is idempotent (clear + insert) across re-runs', async () => {
    const db = seedGlobalDb();
    try {
      await synthesizeWisdom(db, NO_BACKEND_CFG);
      const first = listWisdom(db).insights.length;
      await synthesizeWisdom(db, NO_BACKEND_CFG);
      const second = listWisdom(db).insights.length;
      expect(second).toBe(first);
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM wisdom_meta`).get() as { n: number }).n;
      expect(rows).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('WisdomSynthesizer agent (v2)', () => {
  it('postprocess coerces missing arrays and derives confidence from headline', () => {
    const post = WISDOM_SYNTHESIZER_AGENT.postprocess!(
      { headline: 'A pragmatic backend engineer', narrative: 'N' } as never,
      { payload: {} as never },
    );
    expect(post.confidence).toBe(0.8);
    expect(post.output.insights).toEqual([]);
    expect(post.output.gaps).toEqual([]);

    const empty = WISDOM_SYNTHESIZER_AGENT.postprocess!(
      { headline: '' } as never, { payload: {} as never },
    );
    expect(empty.confidence).toBe(0);
  });
});
