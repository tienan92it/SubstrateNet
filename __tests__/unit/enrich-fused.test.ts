import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openCodeDb, openKnowledgeDb } from '../../src/db/connection';
import { syncProject } from '../../src/code/sync';
import { buildDomainFuserPayload, buildIndustryFuserPayload } from '../../src/pipeline/enrich-fused';
import { upsertKNode } from '../../src/knowledge/store';
import { buildSetupPlan } from '../../src/setup/plan';

describe('enrich-fused payloads', () => {
  it('builds domain fuser payload from seeded knowledge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-fused-'));
    writeFileSync(join(root, 'index.ts'), 'export const app = 1;\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo-app', description: 'Payments API' }));
    await syncProject(root);
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const now = Date.now();
      upsertKNode(knowDb, {
        id: 'ent1', kind: 'entity', title: 'Account',
        summary: 'Customer account', confidence: 0.9, source: 'test',
        grounding: 'stated', createdAt: now, updatedAt: now,
      });
      upsertKNode(knowDb, {
        id: 'rule1', kind: 'business_rule', title: 'Settlement window',
        summary: 'T+2 settlement', confidence: 0.8, source: 'test',
        grounding: 'stated', scope: 'industry', createdAt: now, updatedAt: now,
      });

      const payload = buildDomainFuserPayload(knowDb, codeDb, root);
      expect(payload).not.toBeNull();
      expect(payload!.corePack).toContain('demo-app');
      expect(payload!.entities.some((e) => e.title === 'Account')).toBe(true);
      expect(payload!.businessItems.length).toBeGreaterThan(0);
    } finally {
      codeDb.close();
      knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds industry fuser payload from code + manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-fused-'));
    writeFileSync(join(root, 'index.ts'), 'export function main() {}\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'shop-ui',
      dependencies: { react: '18.0.0', next: '14.0.0' },
    }));
    await syncProject(root);
    const codeDb = openCodeDb(root);
    const knowDb = openKnowledgeDb(root);
    try {
      const now = Date.now();
      upsertKNode(knowDb, {
        id: 'dep1', kind: 'dependency', title: 'react',
        confidence: 1, source: 'manifest', grounding: 'structural',
        createdAt: now, updatedAt: now,
      });

      const payload = buildIndustryFuserPayload(knowDb, codeDb, root);
      expect(payload).not.toBeNull();
      expect(payload!.projectName).toBe('shop-ui');
      expect(payload!.dependencyHistogram.some((d) => d.name === 'react')).toBe(true);
    } finally {
      codeDb.close();
      knowDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('setup plan fused enrich', () => {
  it('standard profile plans 2 fused enrich calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-fused-plan-'));
    writeFileSync(join(root, 'main.ts'), 'export const x = 1;\n');
    const plan = await buildSetupPlan([root], { profile: 'standard' });
    const fused = plan.phases.find((p) => p.phase === 'enrich-fused');
    expect(fused).toBeDefined();
    expect(fused!.calls).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
