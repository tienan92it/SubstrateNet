import { describe, it, expect } from 'vitest';
import { CursorBackend } from '../../src/agents/backends/cursor.js';

describe('CursorBackend', () => {
  it('maps a finished run result to chat content', async () => {
    const backend = new CursorBackend({
      apiKey: 'k',
      runner: async () => ({ status: 'finished', result: '{"ok":true}' }),
    });
    const res = await backend.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], jsonMode: true });
    expect(res.content).toBe('{"ok":true}');
  });

  it('throws when the run status is error', async () => {
    const backend = new CursorBackend({ apiKey: 'k', runner: async () => ({ status: 'error' }) });
    await expect(backend.chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/run failed/);
  });

  it('flattens system+user messages and appends a JSON-only guard', async () => {
    let seen = '';
    const backend = new CursorBackend({
      apiKey: 'k',
      runner: async (prompt) => { seen = prompt; return { status: 'finished', result: '{}' }; },
    });
    await backend.chat({
      model: 'auto', jsonMode: true,
      messages: [{ role: 'system', content: 'classify this' }, { role: 'user', content: 'DATA' }],
    });
    expect(seen).toContain('classify this');
    expect(seen).toContain('DATA');
    expect(seen).toContain('ONLY a single valid JSON object');
  });
});
