/**
 * PARA organization tests (deterministic, no LLM):
 *   - projectStatus classifies actionability from session recency
 *   - levelFor / normalizeLevel Dreyfus bucketing (moved here from wisdom)
 *   - deterministicOrganize groups by structural fields (kind, domains), no keywords
 *   - organizeKnowledge + listPara round-trip with no usable backend
 *   - KnowledgeOrganizer agent postprocess coercion
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  projectStatus, levelFor, normalizeLevel, deterministicOrganize,
  organizeKnowledge, listPara,
} from '../../src/global/organize.js';
import {
  KNOWLEDGE_ORGANIZER_AGENT, type KnowledgeOrganizerPayload,
} from '../../src/agents/knowledge-organizer.js';

function seedGlobalDb() {
  const db = new Database(':memory:');
  const schema = readFileSync(join(__dirname, '..', '..', 'src', 'db', 'global-schema.sql'), 'utf8');
  db.exec(schema);
  const now = Date.now();
  // Project paths are bogus so projectActivity returns the empty default (no local db).
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p1', 'alpha', '/tmp/subnet-organize-test-alpha-zzz', now, now);
  db.prepare(`INSERT INTO projects (id,name,path,registered_at,last_seen_at) VALUES (?,?,?,?,?)`)
    .run('p2', 'beta', '/tmp/subnet-organize-test-beta-zzz', now, now);

  const skill = db.prepare(`INSERT INTO skills (id,name,scope,kind,evidence_weight,grounding,project_count,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  skill.run('s1', 'typescript', 'technical', 'language', 9, 'structural', 2, now);
  skill.run('s2', 'postgres', 'technical', 'tool', 6, 'corroborated', 2, now);
  skill.run('s3', 'docker', 'technical', 'tool', 5, 'structural', 3, now);
  skill.run('s4', 'react', 'technical', 'framework', 7, 'structural', 2, now);

  db.prepare(`INSERT INTO business_domains (id,project_id,name,summary,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('bd1', 'p1', 'Payments', 'money movement', 'stated', now);
  db.prepare(`INSERT INTO tech_domains (id,project_id,name,summary,grounding,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('td1', 'p1', 'Authentication', 'tokens', 'stated', now);
  db.prepare(`INSERT INTO concepts_global (id,project_id,local_concept_id,name,summary,domain,scope,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('c1', 'p1', 'lc1', 'Idempotent payments', 'dedup charges', 'Payments', 'industry', now);
  return db;
}

const NO_BACKEND_CFG = {
  agentBackends: { openrouter: { kind: 'openai-compatible', apiKeyEnv: 'SUBNET_TEST_NO_KEY_ZZZ' } },
  agents: { knowledgeOrganizer: { model: 'openrouter:test-model' } },
} as any;

describe('projectStatus (actionability from activity)', () => {
  it('classifies by session recency, not keywords', () => {
    expect(projectStatus(0)).toBe('active');
    expect(projectStatus(45)).toBe('active');
    expect(projectStatus(120)).toBe('archived');
    expect(projectStatus(null)).toBe('archived'); // never seen locally
  });
});

describe('levelFor + normalizeLevel (Dreyfus)', () => {
  it('buckets by weight and project spread', () => {
    expect(levelFor(15, 1)).toBe('expert');
    expect(levelFor(0, 5)).toBe('expert');
    expect(levelFor(7, 1)).toBe('proficient');
    expect(levelFor(4, 1)).toBe('competent');
    expect(levelFor(1.5, 1)).toBe('advanced_beginner');
    expect(levelFor(0.2, 1)).toBe('novice');
  });
  it('coerces arbitrary level strings', () => {
    expect(normalizeLevel('Expert')).toBe('expert');
    expect(normalizeLevel('advanced beginner')).toBe('advanced_beginner');
    expect(normalizeLevel('Intermediate')).toBe('competent');
    expect(normalizeLevel('senior engineer')).toBe('proficient');
    expect(normalizeLevel(undefined)).toBe('competent');
  });
});

describe('deterministicOrganize (data-driven, no keywords)', () => {
  const payload: KnowledgeOrganizerPayload = {
    projects: [
      { id: 'p1', name: 'alpha', idleDays: 5, recentSessions: 3, totalSessions: 10, industries: ['Fintech'], domains: ['Payments'] },
      { id: 'p2', name: 'beta', idleDays: 200, recentSessions: 0, totalSessions: 4, industries: [], domains: [] },
    ],
    skills: [
      { name: 'typescript', weight: 9, grounding: 'structural', projectCount: 2, kind: 'language' },
      { name: 'docker', weight: 5, grounding: 'structural', projectCount: 3, kind: 'tool' },
      { name: 'react', weight: 7, grounding: 'structural', projectCount: 2, kind: 'framework' },
    ],
    domains: [
      { name: 'Payments', summary: 'money', kind: 'business' },
      { name: 'Authentication', summary: 'tokens', kind: 'tech' },
    ],
    concepts: [{ name: 'Idempotent payments', summary: 'dedup' }],
  };
  // Attach the concept→domain map the gather step normally provides.
  (payload as any)._conceptDomains = new Map([['idempotent payments', 'Payments']]);

  it('classifies projects active/archived from idleDays', () => {
    const out = deterministicOrganize(payload);
    const p1 = out.projects.find((p) => p.id === 'p1');
    const p2 = out.projects.find((p) => p.id === 'p2');
    expect(p1?.status).toBe('active');
    expect(p2?.status).toBe('archived');
  });

  it('groups skills into areas by structural kind, leveled by evidence', () => {
    const out = deterministicOrganize(payload);
    const langs = out.areas.find((a) => a.name === 'Languages');
    const tools = out.areas.find((a) => a.name === 'Tooling & Infrastructure');
    expect(langs?.skills).toContain('typescript');
    expect(tools?.skills).toContain('docker');
    // docker projectCount=3 → proficient
    expect(tools?.level).toBe('proficient');
  });

  it('builds subjects from real domains and attaches concepts by their domain field', () => {
    const out = deterministicOrganize(payload);
    const tech = out.subjects.find((s) => s.name === 'Technical Domains');
    const biz = out.subjects.find((s) => s.name === 'Business & Industry');
    expect(tech?.topics.some((t) => t.name === 'Authentication')).toBe(true);
    const payTopic = biz?.topics.find((t) => t.name === 'Payments');
    expect(payTopic?.items.some((i) => i.kind === 'concept' && i.name === 'Idempotent payments')).toBe(true);
  });
});

describe('organizeKnowledge + listPara', () => {
  it('persists a data-driven PARA layer when no LLM backend is usable', async () => {
    const db = seedGlobalDb();
    try {
      const stats = await organizeKnowledge(db, NO_BACKEND_CFG);
      expect(stats.source).toBe('deterministic');
      expect(stats.areas).toBeGreaterThan(0);
      expect(stats.subjects).toBeGreaterThan(0);

      const para = listPara(db);
      // Both projects have bogus paths (no local sessions) → archived.
      expect(para.archives.length).toBe(2);
      expect(para.projects.length).toBe(0);
      expect(para.areas.length).toBe(stats.areas);
      expect(para.subjects.some((s) => s.name === 'Technical Domains')).toBe(true);
      for (const a of para.areas) {
        expect(['novice', 'advanced_beginner', 'competent', 'proficient', 'expert']).toContain(a.level);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent across re-runs (clear + insert)', async () => {
    const db = seedGlobalDb();
    try {
      await organizeKnowledge(db, NO_BACKEND_CFG);
      const first = listPara(db);
      await organizeKnowledge(db, NO_BACKEND_CFG);
      const second = listPara(db);
      expect(second.areas.length).toBe(first.areas.length);
      expect(second.subjects.length).toBe(first.subjects.length);
      const projRows = (db.prepare(`SELECT COUNT(*) AS n FROM para_projects`).get() as { n: number }).n;
      expect(projRows).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('KnowledgeOrganizer agent', () => {
  it('postprocess coerces missing arrays and derives confidence', () => {
    const post = KNOWLEDGE_ORGANIZER_AGENT.postprocess!(
      { projects: [{ id: 'p1', status: 'active' }], areas: [{ name: 'Backend', level: 'expert', skills: ['node'] }], subjects: [{ name: 'Web', topics: [] }] } as never,
      { payload: {} as never },
    );
    expect(post.confidence).toBe(0.8);
    expect(Array.isArray(post.output.projects)).toBe(true);

    const empty = KNOWLEDGE_ORGANIZER_AGENT.postprocess!(
      { areas: [], subjects: [] } as never, { payload: {} as never },
    );
    expect(empty.confidence).toBe(0);
  });
});
