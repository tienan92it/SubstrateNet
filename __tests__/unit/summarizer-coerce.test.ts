import { describe, it, expect } from 'vitest';
import { SUMMARIZER_AGENT } from '../../src/agents/summarizer';

describe('Summarizer schema tolerance', () => {
  it('coerces array/object structured fields to strings', () => {
    const out = SUMMARIZER_AGENT.postprocess!(
      {
        name: 'session caching',
        summary: 'Use Redis for sessions.',
        structured: {
          // Models sometimes return non-strings here.
          options: ['redis', 'in-memory'] as any,
          decision: { chosen: 'redis' } as any,
          problem: 'sessions lost across instances',
        },
      } as any,
      { payload: { conceptId: 'c1', facts: [] } },
    );
    expect(out.output.structured.options).toBe('redis; in-memory');
    expect(out.output.structured.decision).toContain('redis');
    expect(out.output.structured.problem).toBe('sessions lost across instances');
  });

  it('drops empty structured fields', () => {
    const out = SUMMARIZER_AGENT.postprocess!(
      { name: 'x', summary: 'y', structured: { options: '' as any, problem: '   ' as any } } as any,
      { payload: { conceptId: 'c1', facts: [] } },
    );
    expect(out.output.structured.options).toBeUndefined();
    expect(out.output.structured.problem).toBeUndefined();
  });
});
