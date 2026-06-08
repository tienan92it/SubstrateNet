import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSetupPlan } from '../../src/setup/plan.js';
import { formatPlanTable } from '../../src/setup/format.js';
import {
  MODEL_PRICING,
  PLAN_AGENT_ALIASES,
  billingModelRef,
  costUsdForAgent,
  resolveAgentSpec,
} from '../../src/setup/plan-cost.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

describe('setup plan', () => {
  it('estimates work for a minimal project tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-setup-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export function main() {}\n');

    const plan = await buildSetupPlan([root]);
    expect(plan.projects).toHaveLength(1);
    const p = plan.projects[0]!;
    expect(p.files).toBeGreaterThanOrEqual(2);
    expect(p.pendingFiles).toBeGreaterThanOrEqual(2);
    expect(p.llmCalls).toBeGreaterThan(0);
    expect(p.phases.length).toBeGreaterThan(0);
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.totals.files).toBe(p.files);
    expect(plan.concurrency).toBeGreaterThanOrEqual(1);
    expect(plan.profile).toBe('standard');
  });

  it('exposes per-phase breakdown with in/out tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-setup-'));
    writeFileSync(join(root, 'main.ts'), 'export const x = 1;\n');

    const plan = await buildSetupPlan([root], { profile: 'standard' });
    const phases = plan.phases.map((ph) => ph.phase);
    expect(phases).toContain('pre-llm');
    expect(phases).toContain('triage');
    expect(phases).toContain('extract');
    expect(phases).toContain('analyze');
    expect(phases).toContain('global');

    const pre = plan.phases.find((ph) => ph.phase === 'pre-llm')!;
    expect(pre.calls).toBe(0);
    expect(pre.note).toBe('mechanical');

    const extract = plan.phases.find((ph) => ph.phase === 'extract')!;
    expect(extract.calls).toBeGreaterThan(0);
    expect(extract.tokensOut).toBeGreaterThan(0);

    expect(plan.totals.estTokensIn).toBeGreaterThan(0);
    expect(plan.totals.estTokensOut).toBeGreaterThan(0);
    expect(plan.totals.estTokens).toBe(plan.totals.estTokensIn + plan.totals.estTokensOut);
  });

  it('lean profile skips analyze and enrich', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-setup-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');

    const plan = await buildSetupPlan([root], { profile: 'lean' });
    expect(plan.phases.find((ph) => ph.phase === 'analyze')).toBeUndefined();
    expect(plan.phases.find((ph) => ph.phase === 'enrich-fused')).toBeUndefined();
    expect(plan.phases.find((ph) => ph.phase === 'enrich')).toBeUndefined();
  });

  it('formatPlanTable renders phase rows', () => {
    const table = formatPlanTable({
      projects: [],
      phases: [
        {
          phase: 'extract',
          calls: 10,
          tokensIn: 12_000,
          tokensOut: 18_000,
          estCostUsd: 0.18,
          estWallMs: 120_000,
        },
      ],
      totals: {
        files: 0,
        pendingFiles: 0,
        sessions: 0,
        estWindows: 10,
        estWindowsKept: 9,
        llmCalls: 10,
        cacheHitPct: 0,
        estTokens: 30_000,
        estTokensIn: 12_000,
        estTokensOut: 18_000,
        estWallMs: 120_000,
        estCostUsd: 0.18,
      },
      backendMode: 'mixed',
      concurrency: 4,
      profile: 'standard',
    });
    expect(table).toContain('Per phase');
    expect(table).toContain('extract');
    expect(table).toContain('Tokens(in)');
  });

  it('uses output-heavy flash pricing', () => {
    const flash = MODEL_PRICING['google/gemini-3.5-flash']!;
    expect(flash.outputPerM).toBeGreaterThan(flash.inputPerM * 3);
  });

  it('resolves batch agents from parent config entries', () => {
    const cfg = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents } };
    delete (cfg.agents as Record<string, unknown>).clustererBatch;
    expect(resolveAgentSpec(cfg, 'clustererBatch')?.model).toBe(cfg.agents.clusterer.model);
    expect(PLAN_AGENT_ALIASES.triageBatch).toBe('triage');
    expect(billingModelRef(cfg, 'clustererBatch')).toContain('gemini-3.5-flash');
  });

  it('prices cluster phase when only parent clusterer is configured', () => {
    const cfg = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents } };
    delete (cfg.agents as Record<string, unknown>).clustererBatch;
    const usd = costUsdForAgent(cfg, 'clustererBatch', 28_000, 18_000);
    expect(usd).toBeGreaterThan(0.2);
  });

  it('prices frontier agents at flash fallback for OpenRouter estimate', () => {
    const cfg = { ...DEFAULT_CONFIG };
    const usd = costUsdForAgent(cfg, 'sourceClassifierBatch', 25_000, 8_000);
    expect(usd).toBeGreaterThan(0.1);
  });

  it('first-run plan uses zero cache before triage completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-setup-cache-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');
    const plan = await buildSetupPlan([root]);
    expect(plan.projects[0]!.cacheHitPct).toBe(0);
  });
});
