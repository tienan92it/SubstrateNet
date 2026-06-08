import { describe, it, expect } from 'vitest';
import { normalizeTurnText } from '../../src/pipeline/normalize-turns';
import { DEFAULT_INGEST_CONFIG } from '../../src/config';

describe('normalize turns', () => {
  it('strips thinking fences and repeated lines', () => {
    const raw = '```thinking\nsecret\n```\n\nHello world\n\nHello world\n\nDone.';
    const out = normalizeTurnText(raw, DEFAULT_INGEST_CONFIG);
    expect(out).not.toContain('secret');
    expect(out).toContain('Hello world');
    expect(out).toContain('Done.');
  });
});
