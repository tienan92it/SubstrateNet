import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSetupPlan } from '../../src/setup/plan.js';

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
    expect(plan.totals.files).toBe(p.files);
    expect(plan.concurrency).toBeGreaterThanOrEqual(1);
  });
});
