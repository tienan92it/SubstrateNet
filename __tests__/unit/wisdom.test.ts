/**
 * L6 wisdom synthesis tests (deterministic, no LLM):
 *   - keyword competency routing + Dreyfus level bucketing (pure)
 *   - deterministicWisdom grouping / insights / gaps passthrough
 *   - synthesizeWisdom + listWisdom round-trip with no usable backend
 *   - WisdomSynthesizer agent postprocess coercion
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  categorizeSkill, levelFor, normalizeLevel, deterministicWisdom,
  synthesizeWisdom, listWisdom,
} from '../../src/global/wisdom.js';
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
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p2', 'beta', '/tmp/subnet-wisdom-test-beta-zzz', now, now);

  const skill = db.prepare(`INSERT INTO skills (id,name,scope,kind,evidence_weight,grounding,project_count,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  skill.run('s1', 'react', 'technical', null, 8, 'structural', 2, now);
  skill.run('s2', 'postgres', 'technical', null, 6, 'corroborated', 2, now);
  skill.run('s3', 'kafka', 'technical', null, 3, 'stated', 1, now);
  skill.run('s4', 'docker', 'technical', null, 5, 'structural', 3, now);
  skill.run('s5', 'llm', 'technical', null, 2, 'stated', 1, now);

  db.prepare(`INSERT INTO industries (id,name,project_id,confidence,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('i1', 'Fintech', 'p1', 0.9, 'stated', now);
  return db;
}

/** A config whose only backend has no resolvable key → forces deterministic. */
const NO_BACKEND_CFG = {
  agentBackends: { openrouter: { kind: 'openai-compatible', apiKeyEnv: 'SUBNET_TEST_NO_KEY_ZZZ' } },
  agents: { wisdomSynthesizer: { model: 'openrouter:test-model' } },
} as any;

describe('categorizeSkill', () => {
  it('routes skills to coherent areas by keyword', () => {
    expect(categorizeSkill('React').area).toBe('Frontend & UX');
    expect(categorizeSkill('postgres').area).toBe('Data & Analytics');
    expect(categorizeSkill('redis').area).toBe('Data & Analytics');
    expect(categorizeSkill('kubernetes').area).toBe('Infrastructure & DevOps');
    expect(categorizeSkill('OAuth').area).toBe('Security');
    expect(categorizeSkill('llm').area).toBe('AI / ML & Agents');
    expect(categorizeSkill('totally-unknown-thing').area).toBe('General Engineering');
  });
});

describe('levelFor (Dreyfus bucketing)', () => {
  it('buckets by weight and project spread', () => {
    expect(levelFor(15, 1)).toBe('expert');
    expect(levelFor(0, 5)).toBe('expert');
    expect(levelFor(7, 1)).toBe('proficient');
    expect(levelFor(0, 3)).toBe('proficient');
    expect(levelFor(4, 1)).toBe('competent');
    expect(levelFor(1.5, 1)).toBe('advanced_beginner');
    expect(levelFor(0.2, 1)).toBe('novice');
  });
});

describe('normalizeLevel', () => {
  it('coerces arbitrary level strings to the five Dreyfus tiers', () => {
    expect(normalizeLevel('Expert')).toBe('expert');
    expect(normalizeLevel('proficient')).toBe('proficient');
    expect(normalizeLevel('advanced beginner')).toBe('advanced_beginner');
    expect(normalizeLevel('Intermediate')).toBe('competent');
    expect(normalizeLevel('beginner')).toBe('novice');
    expect(normalizeLevel('senior engineer')).toBe('proficient');
    expect(normalizeLevel(undefined)).toBe('competent');
  });
});

describe('deterministicWisdom', () => {
  const payload: WisdomSynthesizerPayload = {
    projectCount: 2,
    industries: [{ name: 'Fintech', projectCount: 2 }],
    skills: [
      { name: 'react', weight: 8, grounding: 'structural', projectCount: 2 },
      { name: 'postgres', weight: 6, grounding: 'corroborated', projectCount: 2 },
      { name: 'docker', weight: 5, grounding: 'structural', projectCount: 3 },
      { name: 'llm', weight: 2, grounding: 'stated', projectCount: 1 },
    ],
    businessDomains: [], techDomains: [], concepts: [],
    highlights: [{ statement: 'Built a payments ledger', grounding: 'corroborated' }],
    gaps: [{ title: 'Ungoverned entity: Ledger', summary: 'no governing rule' }],
  };

  it('groups every supplied skill without inventing any', () => {
    const out = deterministicWisdom(payload);
    expect(out.competencies.length).toBeGreaterThan(0);
    const placed = out.competencies.flatMap((c) => c.skills).sort();
    expect(placed).toEqual(['docker', 'llm', 'postgres', 'react']);
  });

  it('assigns evidence-based levels and passes gaps through with a recommendation', () => {
    const out = deterministicWisdom(payload);
    const infra = out.competencies.find((c) => c.area === 'Infrastructure & DevOps');
    expect(infra?.skills).toContain('docker');
    expect(infra?.level).toBe('proficient'); // docker: projectCount 3
    expect(out.gaps[0].title).toBe('Ungoverned entity: Ledger');
    expect(out.gaps[0].recommendation).toBeTruthy();
    expect(out.insights.some((i) => i.title === 'Consistent cross-project strengths')).toBe(true);
    expect(out.headline).toBeTruthy();
  });
});

describe('synthesizeWisdom + listWisdom', () => {
  it('persists a deterministic layer when no LLM backend is usable', async () => {
    const db = seedGlobalDb();
    try {
      const stats = await synthesizeWisdom(db, NO_BACKEND_CFG);
      expect(stats.source).toBe('deterministic');
      expect(stats.competencies).toBeGreaterThan(0);

      const w = listWisdom(db);
      expect(w.headline).toBeTruthy();
      expect(w.grounding).toBe('model');
      expect(w.competencies.length).toBe(stats.competencies);
      for (const c of w.competencies) {
        expect(['novice', 'advanced_beginner', 'competent', 'proficient', 'expert']).toContain(c.level);
      }
      const infra = w.competencies.find((c) => c.name === 'Infrastructure & DevOps');
      expect(infra?.skills.some((s) => s.name === 'docker')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is idempotent (clear + insert) across re-runs', async () => {
    const db = seedGlobalDb();
    try {
      await synthesizeWisdom(db, NO_BACKEND_CFG);
      const first = listWisdom(db).competencies.length;
      await synthesizeWisdom(db, NO_BACKEND_CFG);
      const second = listWisdom(db).competencies.length;
      expect(second).toBe(first);
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM wisdom_meta`).get() as { n: number }).n;
      expect(rows).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('WisdomSynthesizer agent', () => {
  it('postprocess coerces missing arrays and derives confidence', () => {
    const post = WISDOM_SYNTHESIZER_AGENT.postprocess!(
      { headline: 'A pragmatic backend engineer', narrative: 'N', competencies: [{ area: 'Backend & APIs', level: 'expert', skills: ['node'] }] } as never,
      { payload: {} as never },
    );
    expect(post.confidence).toBe(0.8);
    expect(post.output.insights).toEqual([]);
    expect(post.output.gaps).toEqual([]);

    const empty = WISDOM_SYNTHESIZER_AGENT.postprocess!(
      { headline: '', competencies: [] } as never, { payload: {} as never },
    );
    expect(empty.confidence).toBe(0);
  });
});
