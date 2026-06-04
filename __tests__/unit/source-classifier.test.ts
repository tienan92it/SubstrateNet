import { describe, it, expect } from 'vitest';
import { SOURCE_CLASSIFIER_AGENT } from '../../src/agents/source-classifier.js';

describe('SOURCE_CLASSIFIER_AGENT', () => {
  it('normalizes invalid doc_kind, lowercases topics, trims area', () => {
    const post = SOURCE_CLASSIFIER_AGENT.postprocess!(
      { doc_kind: 'spec-sheet' as any, topics: ['Payments', ' KYC '], area: ' billing ' },
      { payload: { text: '', sourcePath: 'docs/x.md' } } as any,
    );
    expect(post.output.doc_kind).toBe('notes');     // invalid -> notes
    expect(post.output.topics).toEqual(['payments', 'kyc']);
    expect(post.output.area).toBe('billing');
  });

  it('keeps a valid doc_kind', () => {
    const post = SOURCE_CLASSIFIER_AGENT.postprocess!(
      { doc_kind: 'brd', topics: [] },
      { payload: { text: '', sourcePath: 'docs/brd.md' } } as any,
    );
    expect(post.output.doc_kind).toBe('brd');
  });
});
