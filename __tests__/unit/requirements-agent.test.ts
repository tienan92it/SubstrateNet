import { describe, it, expect } from 'vitest';
import { REQUIREMENTS_AGENT } from '../../src/agents/requirements.js';

describe('REQUIREMENTS_AGENT', () => {
  it('keeps allowed kinds and drops invented ones', () => {
    const out = REQUIREMENTS_AGENT.postprocess!(
      {
        facts: [
          { kind: 'actor', title: 'Borrower', confidence: 0.9 },
          { kind: 'process', title: 'Loan origination', confidence: 0.8 },
          { kind: 'metric', title: 'approval turnaround < 24h', confidence: 0.7 },
          // not in allowedKinds -> dropped
          { kind: 'decision' as any, title: 'use Postgres', confidence: 0.9 },
        ],
      },
      { payload: { text: '', windowId: 'w1' } } as any,
    );
    const kinds = out.output.facts.map((f) => f.kind);
    expect(kinds).toContain('actor');
    expect(kinds).toContain('process');
    expect(kinds).toContain('metric');
    expect(kinds).not.toContain('decision');
  });

  it('builds a system prompt listing the allowed kinds', () => {
    const msgs = REQUIREMENTS_AGENT.prompt({ payload: { text: 'hi', windowId: 'w1' } } as any);
    const system = msgs.find((m) => m.role === 'system')!.content;
    expect(system).toContain('actor');
    expect(system).toContain('metric');
  });
});
