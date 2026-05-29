/**
 * Domain enrichment tests.
 *   - Structural extraction from a real SQL schema (deterministic, no LLM).
 *   - Gap detector: external FK targets + ungoverned central entities.
 *   - DomainModeler agent: evidence enforcement (drops unsupported claims).
 *   - Full enrichment with --no-agent.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCodeDb, openKnowledgeDb } from '../../src/db/connection';
import { syncProject } from '../../src/code/sync';
import { runDomainFromCode } from '../../src/pipeline/domain-from-code';
import { runGapDetector } from '../../src/pipeline/gap-detector';
import { runEnrichment } from '../../src/pipeline/enrich';
import { DOMAIN_MODELER_AGENT } from '../../src/agents/domain-modeler';
import { listEntities, relationshipsFor, listGaps } from '../../src/knowledge/domain-store';
import { AgentRuntime } from '../../src/agents/runtime';
import { DEFAULT_CONFIG } from '../../src/config';

const SCHEMA = `
CREATE TABLE "public"."accounts" (
  "id" uuid NOT NULL,
  "tier" uuid REFERENCES tier(id),
  PRIMARY KEY ("id")
);
CREATE TABLE "public"."users" (
  "id" uuid NOT NULL,
  "email" varchar,
  PRIMARY KEY ("id")
);
CREATE TABLE "public"."users_accounts" (
  "id" uuid NOT NULL,
  "user_id" uuid REFERENCES users(id),
  "account_id" uuid REFERENCES accounts(id),
  PRIMARY KEY ("id")
);
`;

async function setupWithSchema(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'codegps-dom-'));
  writeFileSync(join(root, 'schema.sql'), SCHEMA);
  await syncProject(root);
  return root;
}

describe('structural domain extraction', () => {
  it('promotes tables to entities and FKs to relationships', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const stats = runDomainFromCode(knowDb, codeDb);
      // accounts, users, users_accounts are real; tier is an external FK stub.
      expect(stats.entities).toBe(3);
      expect(stats.externalEntities).toBe(1);
      // users_accounts→users, users_accounts→accounts, accounts→tier = 3
      expect(stats.relationships).toBe(3);

      const entities = listEntities(knowDb);
      const titles = entities.map((e) => e.title).sort();
      expect(titles).toEqual(expect.arrayContaining(['accounts', 'users', 'users_accounts', 'tier']));
      // every structural entity is grounded as 'structural' with a code link
      for (const e of entities) {
        expect(e.grounding).toBe('structural');
      }
      const ua = entities.find((e) => e.title === 'users_accounts')!;
      expect(ua.codeFiles).toContain('schema.sql');

      const rels = relationshipsFor(knowDb, ua.id).filter((r) => r.fromId === ua.id);
      expect(rels.map((r) => r.toTitle).sort()).toEqual(['accounts', 'users']);
      expect(rels.every((r) => r.grounding === 'structural' && r.evidence)).toBe(true);
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-running adds no duplicate relationships', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      runDomainFromCode(knowDb, codeDb);
      const second = runDomainFromCode(knowDb, codeDb);
      expect(second.relationships).toBe(0); // all already present
      const edgeCount = (knowDb.prepare(`SELECT COUNT(*) AS n FROM k_edges WHERE kind='relates_to'`).get() as any).n;
      expect(edgeCount).toBe(3);
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gap detector', () => {
  it('flags external FK targets and ungoverned central entities', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      runDomainFromCode(knowDb, codeDb);
      const stats = runGapDetector(knowDb);
      // tier is external → 1 external-ref gap
      expect(stats.externalRefs).toBe(1);
      // accounts + users + users_accounts participate in relationships and have
      // no governing rule → ungoverned gaps
      expect(stats.ungovernedEntities).toBeGreaterThanOrEqual(1);

      const gaps = listGaps(knowDb);
      expect(gaps.some((g) => g.title.includes('tier'))).toBe(true);
      // every gap carries evidence and is structurally grounded
      for (const g of gaps) {
        expect(g.evidenceText).toBeTruthy();
        expect(g.grounding).toBe('structural');
      }
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a central entity once a business rule references it', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      runDomainFromCode(knowDb, codeDb);
      // Add a business rule mentioning "accounts".
      knowDb.prepare(`INSERT INTO k_nodes (id,kind,title,summary,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run('r1', 'business_rule', 'accounts must be verified', 'an account is active only after email verification', 0.9, 'agent:businessLogic', Date.now(), Date.now());
      runGapDetector(knowDb);
      const gaps = listGaps(knowDb);
      // No "ungoverned" gap for accounts (a rule references it); tier external gap still present.
      expect(gaps.some((g) => g.title === 'Entity without documented rules: accounts')).toBe(false);
      expect(gaps.some((g) => g.title.includes('tier'))).toBe(true);
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DomainModeler agent — evidence enforcement', () => {
  const input = {
    payload: {
      entities: [{ id: 'a', title: 'Workspace' }, { id: 'b', title: 'Project' }, { id: 'c', title: 'Member' }],
      facts: [{ kind: 'business_rule', title: 'a workspace owns many projects', evidence: 'a workspace can have many projects' }],
    },
  };

  it('keeps relationships with evidence between known entities; drops the rest', () => {
    const post = DOMAIN_MODELER_AGENT.postprocess!(
      {
        relationships: [
          { from: 'Workspace', to: 'Project', kind: 'part_of', evidence: 'a workspace can have many projects' }, // keep
          { from: 'Workspace', to: 'Project', kind: 'relates_to', evidence: '' },                                  // drop: no evidence
          { from: 'Workspace', to: 'Unknown', kind: 'relates_to', evidence: 'quote' },                             // drop: unknown entity
          { from: 'Workspace', to: 'Workspace', kind: 'relates_to', evidence: 'quote' },                           // drop: self
        ],
        gaps: [
          { title: 'billing owner undefined', why: 'no entity owns billing', evidence: 'who pays for the workspace?' }, // keep
          { title: 'no evidence gap', why: 'x', evidence: '' },                                                          // drop
        ],
      },
      input as any,
    );
    expect(post.output.relationships).toHaveLength(1);
    expect(post.output.relationships[0].to).toBe('Project');
    expect(post.output.gaps).toHaveLength(1);
    expect(post.output.gaps[0].title).toBe('billing owner undefined');
  });
});

describe('full enrichment (no agent)', () => {
  it('runs structural + deterministic gaps end-to-end and persists a queryable model', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const stats = await runEnrichment(knowDb, codeDb, cfg, { noAgent: true });
      expect(stats.structuralEntities).toBe(3);
      expect(stats.structuralRelationships).toBe(3);
      expect(stats.detectedGaps).toBeGreaterThanOrEqual(1);
      expect(stats.agentRelationships).toBe(0); // agent skipped
      expect(listEntities(knowDb).length).toBe(4);
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists agent relationships when a backend is available', async () => {
    const root = await setupWithSchema();
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      runDomainFromCode(knowDb, codeDb); // entities exist for title→id mapping
      // a business rule the modeler can ground a relationship on
      knowDb.prepare(`INSERT INTO k_nodes (id,kind,title,summary,evidence_text,confidence,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('r1', 'business_rule', 'a user joins accounts', 'a user can belong to many accounts', 'users belong to accounts', 0.9, 'agent:businessLogic', Date.now(), Date.now());

      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const orig = AgentRuntime.prototype.run;
      AgentRuntime.prototype.run = async function (agent: any) {
        if (agent.name === 'domainModeler') {
          // Return one valid relationship (users→accounts) and one gap, both with evidence.
          const raw = {
            relationships: [{ from: 'users', to: 'accounts', kind: 'relates_to', evidence: 'users belong to accounts' }],
            gaps: [{ title: 'account tier policy', why: 'tier referenced but undefined', evidence: 'accounts.tier' }],
          };
          const post = agent.postprocess(raw, { payload: { entities: listEntities(knowDb).map((e: any) => ({ id: e.id, title: e.title })), facts: [] } });
          return { output: post.output, confidence: post.confidence, model: 'fake', cached: false } as any;
        }
        return { output: {}, confidence: 0, model: 'fake', cached: false } as any;
      };
      try {
        const stats = await runEnrichment(knowDb, codeDb, cfg, {});
        expect(stats.agentRelationships).toBe(1);
        expect(stats.agentGaps).toBe(1);
        // the stated relationship is persisted with grounding 'stated'
        const usersEntity = listEntities(knowDb).find((e) => e.title === 'users')!;
        const rels = relationshipsFor(knowDb, usersEntity.id);
        expect(rels.some((r) => r.toTitle === 'accounts' && r.grounding === 'stated')).toBe(true);
      } finally {
        AgentRuntime.prototype.run = orig;
      }
    } finally {
      codeDb.close(); knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
