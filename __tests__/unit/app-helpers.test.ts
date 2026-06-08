import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { resolveTargetProjects } from '../../src/app/projects';
import { isUnhealthy } from '../../src/app/update';
import type { RunProjectResult } from '../../src/pipeline/run-project';

function result(over: Partial<RunProjectResult>): RunProjectResult {
  return { path: '/p', name: 'p', ok: true, stages: {}, durationMs: 0, runs: 0, failures: 0, ...over };
}

describe('resolveTargetProjects', () => {
  it('returns the single resolved path when one is given', () => {
    expect(resolveTargetProjects('./foo')).toEqual([resolve('./foo')]);
  });
});

describe('isUnhealthy', () => {
  it('flags an outright failure', () => {
    expect(isUnhealthy(result({ ok: false }))).toBe(true);
  });

  it('flags a high failure rate over a meaningful sample', () => {
    expect(isUnhealthy(result({ runs: 100, failures: 10 }))).toBe(true);
  });

  it('ignores a few failures in a small sample', () => {
    expect(isUnhealthy(result({ runs: 5, failures: 2 }))).toBe(false);
  });

  it('passes a clean run', () => {
    expect(isUnhealthy(result({ runs: 100, failures: 1 }))).toBe(false);
  });
});
