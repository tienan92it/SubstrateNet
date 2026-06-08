import { describe, it, expect } from 'vitest';
import { fileTier } from '../../src/code/file-tiers';

describe('file tiers', () => {
  it('skips test and fixture paths', () => {
    expect(fileTier('src/__tests__/app.test.ts')).toBe(0);
    expect(fileTier('src/fixtures/data.json')).toBe(0);
  });

  it('marks entrypoints as tier 1 candidates', () => {
    expect(fileTier('src/index.ts')).toBe(1);
    expect(fileTier('src/main.ts')).toBe(1);
  });

  it('marks ordinary sources as tier 2', () => {
    expect(fileTier('src/lib/util.ts')).toBe(2);
  });
});
