import { describe, it, expect } from 'vitest';
import { filterFactsByAnchor } from '../../src/pipeline/fact-filter';
import { DEFAULT_INGEST_CONFIG } from '../../src/config';
import type { WindowBrief } from '../../src/pipeline/window-brief';

const brief: WindowBrief = {
  windowId: 'w1',
  sessionId: 's1',
  sourceAgent: 'cursor',
  narrative: 'n',
  quotes: [],
  symbols: [],
  tickets: ['KAFI-12'],
  paths: ['src/api.ts'],
  charBudget: 0,
};

describe('fact filter anchor gate', () => {
  it('keeps core kinds and drops unanchored intent', () => {
    const { kept, rejected } = filterFactsByAnchor([
      { kind: 'decision', title: 'Use Redis', confidence: 0.9 },
      { kind: 'intent', title: 'vague goal', confidence: 0.8 },
      { kind: 'intent', title: 'fix KAFI-12', confidence: 0.8 },
    ], brief, DEFAULT_INGEST_CONFIG);
    expect(kept.map((f) => f.title)).toContain('Use Redis');
    expect(kept.map((f) => f.title)).toContain('fix KAFI-12');
    expect(kept.map((f) => f.title)).not.toContain('vague goal');
    expect(rejected).toBeGreaterThanOrEqual(1);
  });

  it('caps facts per window', () => {
    const facts = Array.from({ length: 12 }, (_, i) => ({
      kind: 'decision' as const,
      title: `d${i}`,
      confidence: 0.5 + i * 0.01,
    }));
    const { kept } = filterFactsByAnchor(facts, brief, DEFAULT_INGEST_CONFIG);
    expect(kept.length).toBe(DEFAULT_INGEST_CONFIG.maxFactsPerWindow);
  });
});
